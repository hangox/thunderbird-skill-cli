// messages.search / messages.recent —— 邮件元数据搜索与近期邮件摘要。
//
// 设计意图：这两条 route 共用同一套"native MessageHeader → 脱敏摘要 DTO"的
// 转换逻辑（docs/03 §数据压缩与分页 冻结的默认字段），区别只在于查询条件的
// 来源（search 是调用方显式条件 + cursor 续取；recent 是账号/文件夹 + 客户端
// 侧按时间倒序），因此放在同一个文件里，避免两份几乎相同的转换代码漂移。
//
// 已知的、需要在真实 Thunderbird 环境核实的简化点（已同步 team-lead）：
// 1) `messages.query()` 没有文档化的排序参数，`recent` 通过"取一个更大的
//    候选批次 + 客户端按 date 倒序截取"来近似"最近 N 封"，不是跨全部邮件的
//    严格全局 Top-N（无 fromDate 限定时做无界扫描不现实）。
// 2) preview/attachmentCount 需要对每条命中结果分别调用 getFull()/
//    listAttachments()，属于 N+1 开销；只在单次返回条数 <= ENRICH_LIMIT 时
//    启用，超过时置空并在响应里给出 warnings 说明，防止大 limit 拖垮响应时延。
// 3) accountIds/folderRefs/from 本轮只支持 0-1 个元素（原生 query() 每次调用
//    只能绑定一个 accountId/folderId/author），传入更多会显式 E_VALIDATION
//    而不是静默只取第一个——沉默丢弃过滤条件比报错更危险。
import type { JsonSchema } from "../schema.js";
import { ISO_TIMESTAMP_SCHEMA, boundedArraySchema, opaqueRefSchema, validate } from "../schema.js";
import { resolveAccountNativeId } from "./accounts.js";
import { buildPreview, htmlToPlainText, maskAddressDisplay, sanitizeBody, stripInvisibleAndBidi } from "./sanitize.js";
import { MailAdapterError, issueRef, resolveRef, type MailAdapterContext } from "./state.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** 超过这个条数就不再对每条结果做 preview/attachmentCount 的 N+1 富化，避免大 limit 拖垮响应时延。 */
const ENRICH_LIMIT = 25;

interface FolderRefPayload { accountNativeId: string; folderNativeId: unknown }
interface MessageRefPayload { messageNativeId: number }

interface MessageSummaryDto {
  messageRef: string;
  accountRef?: string;
  folderRef?: string;
  headerMessageId: string;
  from: string;
  subject: string;
  receivedAt: string;
  flags: { read: boolean; flagged: boolean; junk: boolean; new: boolean };
  preview?: string;
  attachmentCount?: number;
}

/** 供 messages.ts 复用：把 "Display Name" <addr@x.com> 形式的地址字符串拆成 {name?, email?}。 */
export function parseAuthorDisplay(author: string): { name?: string; email?: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(author);
  if (match) {
    const name = match[1]!.trim();
    return { email: match[2]!.trim(), ...(name ? { name } : {}) };
  }
  if (/^[^\s@]+@[^\s@]+$/.test(author.trim())) return { email: author.trim() };
  return { name: author.trim() };
}

/** 供 messages.ts 复用：MessageHeader.date 官方类型是 `Date`，这里同时容错字符串形态。 */
export function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** 供 messages.ts（message get）复用：从 getFull() 返回的 MIME part 树里挑一段可读正文，优先 text/plain，缺失时退到 text/html。 */
export function extractPlainText(part: MessagePart | undefined): { text: string; format: "text" | "html" } | undefined {
  if (!part) return undefined;
  const contentType = (part.contentType ?? "").toLowerCase();
  if (contentType.startsWith("text/plain") && typeof part.body === "string") return { text: part.body, format: "text" };
  if (contentType.startsWith("text/html") && typeof part.body === "string") return { text: part.body, format: "html" };
  let htmlFallback: { text: string; format: "text" | "html" } | undefined;
  for (const child of part.parts ?? []) {
    const found = extractPlainText(child);
    if (!found) continue;
    if (found.format === "text") return found;
    if (!htmlFallback) htmlFallback = found;
  }
  return htmlFallback;
}

async function enrichOne(nativeId: number): Promise<{ preview?: string; attachmentCount?: number }> {
  const [full, attachments] = await Promise.all([
    browser.messages.getFull(nativeId).catch(() => undefined),
    browser.messages.listAttachments(nativeId).catch(() => undefined),
  ]);
  const extracted = extractPlainText(full);
  const preview = extracted ? buildPreview(sanitizeBody(extracted.text, extracted.format), 240) : undefined;
  const out: { preview?: string; attachmentCount?: number } = {};
  if (preview !== undefined) out.preview = preview;
  if (attachments !== undefined) out.attachmentCount = attachments.length;
  return out;
}

async function toSummaryDto(header: MessageHeader, context: MailAdapterContext, enrich: boolean): Promise<MessageSummaryDto> {
  const messageRef = issueRef("msg", context, { messageNativeId: header.id } satisfies MessageRefPayload);
  const accountNativeId = header.accountId ?? header.folder?.accountId;
  const dto: MessageSummaryDto = {
    messageRef,
    headerMessageId: header.headerMessageId,
    from: maskAddressDisplay(parseAuthorDisplay(header.author)),
    subject: stripInvisibleAndBidi(header.subject ?? ""),
    receivedAt: toDate(header.date).toISOString(),
    flags: { read: header.read, flagged: header.flagged, junk: header.junk, new: header.new },
  };
  if (accountNativeId) dto.accountRef = issueRef("acc", context, { accountNativeId });
  if (header.folder) dto.folderRef = issueRef("folder", context, { accountNativeId: accountNativeId ?? header.folder.accountId, folderNativeId: header.folder.id } satisfies FolderRefPayload);
  if (enrich) {
    const extra = await enrichOne(header.id);
    if (extra.preview !== undefined) dto.preview = extra.preview;
    if (extra.attachmentCount !== undefined) dto.attachmentCount = extra.attachmentCount;
  }
  return dto;
}

// ---------------------------------------------------------------------------
// messages.search
// ---------------------------------------------------------------------------

const SEARCH_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 512 },
    accountIds: boundedArraySchema(opaqueRefSchema("acc"), 8),
    folderRefs: boundedArraySchema(opaqueRefSchema("folder"), 8),
    from: boundedArraySchema({ type: "string", minLength: 1, maxLength: 320 }, 8),
    after: ISO_TIMESTAMP_SCHEMA,
    before: ISO_TIMESTAMP_SCHEMA,
    hasAttachments: { type: "boolean" },
    includeBody: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
    cursor: opaqueRefSchema("cursor"),
  },
  required: [],
};

interface SearchBody {
  query?: string;
  accountIds?: string[];
  folderRefs?: string[];
  from?: string[];
  after?: string;
  before?: string;
  hasAttachments?: boolean;
  includeBody?: boolean;
  limit?: number;
  cursor?: string;
}

interface CursorPayload { messageListId: string }

export async function messagesSearch(body: unknown, context: MailAdapterContext): Promise<{ messages: MessageSummaryDto[]; nextCursor?: string; warnings: string[] }> {
  const result = validate(SEARCH_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `search 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as SearchBody;
  if (parsed.includeBody === true) throw new MailAdapterError("E_VALIDATION", "search 不支持 includeBody:true，正文读取请使用 message get");
  for (const [field, values] of [["accountIds", parsed.accountIds], ["folderRefs", parsed.folderRefs], ["from", parsed.from]] as const) {
    if (values && values.length > 1) throw new MailAdapterError("E_VALIDATION", `本轮 ${field} 只支持最多 1 个元素（原生查询每次只能绑定单个条件）`);
  }
  const limit = parsed.limit ?? DEFAULT_LIMIT;
  const warnings: string[] = [];

  let list: MessageList;
  if (parsed.cursor) {
    const cursorPayload = resolveRef<CursorPayload>("cursor", parsed.cursor, context);
    list = await browser.messages.continueList(cursorPayload.messageListId);
  } else {
    const queryInfo: MessageQueryInfo = { messagesPerPage: limit, returnMessageListId: true };
    if (parsed.query) queryInfo.fullText = parsed.query;
    if (parsed.hasAttachments !== undefined) queryInfo.attachment = parsed.hasAttachments;
    if (parsed.after) queryInfo.fromDate = new Date(parsed.after);
    if (parsed.before) queryInfo.toDate = new Date(parsed.before);
    if (parsed.from?.[0]) queryInfo.author = parsed.from[0];
    let folderAccountNativeId: string | undefined;
    if (parsed.folderRefs?.[0]) {
      const folderPayload = resolveRef<FolderRefPayload>("folder", parsed.folderRefs[0], context);
      queryInfo.folderId = folderPayload.folderNativeId;
      folderAccountNativeId = folderPayload.accountNativeId;
    }
    if (parsed.accountIds?.[0]) {
      const accountNativeId = resolveAccountNativeId(parsed.accountIds[0], context);
      if (folderAccountNativeId && folderAccountNativeId !== accountNativeId) {
        throw new MailAdapterError("E_VALIDATION", "folderRefs 与 accountIds 指向不同账号");
      }
      queryInfo.accountId = accountNativeId;
    }
    list = await browser.messages.query(queryInfo);
  }

  const enrich = list.messages.length <= ENRICH_LIMIT;
  if (!enrich) warnings.push(`结果条数超过 ${ENRICH_LIMIT}，本次响应不含 preview/attachmentCount`);
  const messages = await Promise.all(list.messages.map((header) => toSummaryDto(header, context, enrich)));

  const out: { messages: MessageSummaryDto[]; nextCursor?: string; warnings: string[] } = { messages, warnings };
  if (list.id && list.messages.length > 0) out.nextCursor = issueRef("cursor", context, { messageListId: list.id } satisfies CursorPayload);
  return out;
}

// ---------------------------------------------------------------------------
// messages.recent
// ---------------------------------------------------------------------------

const RECENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    accountRef: opaqueRefSchema("acc"),
    folderRef: opaqueRefSchema("folder"),
    limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
  },
  required: [],
};

interface RecentBody {
  accountRef?: string;
  folderRef?: string;
  limit?: number;
}

/** 候选批次相对目标 limit 的放大倍数：用于近似"最近 N 封"（见文件头注释①）。 */
const RECENT_CANDIDATE_FACTOR = 3;
const RECENT_CANDIDATE_CAP = 300;

export async function messagesRecent(body: unknown, context: MailAdapterContext): Promise<{ messages: MessageSummaryDto[]; warnings: string[] }> {
  const result = validate(RECENT_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `recent 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as RecentBody;
  const limit = parsed.limit ?? DEFAULT_LIMIT;
  const warnings: string[] = ["recent 基于候选批次客户端排序近似“最近”，不保证跨全部邮件的严格全局排序"];

  const queryInfo: MessageQueryInfo = { messagesPerPage: Math.min(limit * RECENT_CANDIDATE_FACTOR, RECENT_CANDIDATE_CAP) };
  let folderAccountNativeId: string | undefined;
  if (parsed.folderRef) {
    const folderPayload = resolveRef<FolderRefPayload>("folder", parsed.folderRef, context);
    queryInfo.folderId = folderPayload.folderNativeId;
    queryInfo.includeSubFolders = true;
    folderAccountNativeId = folderPayload.accountNativeId;
  }
  if (parsed.accountRef) {
    const accountNativeId = resolveAccountNativeId(parsed.accountRef, context);
    if (folderAccountNativeId && folderAccountNativeId !== accountNativeId) {
      throw new MailAdapterError("E_VALIDATION", "folderRef 与 accountRef 指向不同账号");
    }
    queryInfo.accountId = accountNativeId;
  }

  const list = await browser.messages.query(queryInfo);
  const sorted = [...list.messages].sort((a, b) => toDate(b.date).getTime() - toDate(a.date).getTime()).slice(0, limit);
  const enrich = sorted.length <= ENRICH_LIMIT;
  if (!enrich) warnings.push(`结果条数超过 ${ENRICH_LIMIT}，本次响应不含 preview/attachmentCount`);
  const messages = await Promise.all(sorted.map((header) => toSummaryDto(header, context, enrich)));
  return { messages, warnings };
}
