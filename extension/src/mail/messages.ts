// message get / message open —— 按稳定引用读取单封邮件（正文净化+分页 cursor）与在 Thunderbird 消息窗口中打开。
//
// `raw` 格式刻意不经过 sanitize.ts：docs/07 把"读取 raw MIME"列为需要明确用户
// 请求的高敏感动作（UX/Skill 层的确认门槛，而非这里能再收紧的 capability），
// 这里只对它做硬字节上限截断，不做隐藏文本/零宽/bidi 净化——因为净化会改变
// 用户显式要求的"原始"内容，与请求语义矛盾。text/markdown 两种格式仍然强制
// 走 sanitize.ts。
//
// body-cursor 分页现状：CLI 侧 `message get` 的参数只有 `--format`/`--max-bytes`
// （见 src/cli.ts MAIL_MOUNTS["message get"]），没有 `--cursor`/`--body-cursor`
// 之类的 flag 能把这里签发的 `nextCursor` 传回来——这是 CLI 外壳（不在我的
// 改动范围）的既有缺口，已同步 team-lead。这里仍然按 docs/03 冻结的响应形状
// 签发 nextCursor，向前兼容；在 CLI 补上对应 flag 前，超限正文实际上只能读到
// 第一段，调用方需要更大的 --max-bytes 或等待 CLI 侧扩展。
import type { JsonSchema } from "../schema.js";
import { opaqueRefSchema, validate } from "../schema.js";
import { extractPlainText, parseAuthorDisplay, toDate } from "./search.js";
import { htmlToMarkdown, maskAddressDisplay, sanitizeBody, stripInvisibleAndBidi, truncateByBytes } from "./sanitize.js";
import { MailAdapterError, issueRef, resolveRef, type MailAdapterContext } from "./state.js";

interface MessageRefPayload { messageNativeId: number }
interface FolderRefPayload { accountNativeId: string; folderNativeId: unknown }
interface BodyCursorPayload { messageNativeId: number; format: "text" | "markdown" | "raw"; offsetBytes: number }

function resolveMessageNativeId(messageRef: string, context: MailAdapterContext): number {
  return resolveRef<MessageRefPayload>("msg", messageRef, context).messageNativeId;
}

async function requireHeader(nativeId: number): Promise<MessageHeader> {
  const header = await browser.messages.get(nativeId).catch(() => undefined);
  if (!header) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  return header;
}

// ---------------------------------------------------------------------------
// message get
// ---------------------------------------------------------------------------

const MESSAGE_GET_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    messageRef: opaqueRefSchema("msg"),
    format: { type: "string", enum: ["text", "markdown", "raw"] },
    maxBytes: { type: "integer", minimum: 1, maximum: 262_144 },
    cursor: opaqueRefSchema("cursor"),
  },
  required: ["messageRef"],
};

interface MessageGetBody {
  messageRef: string;
  format?: "text" | "markdown" | "raw";
  maxBytes?: number;
  cursor?: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

async function readBodyText(nativeId: number, format: "text" | "markdown" | "raw"): Promise<string> {
  if (format === "raw") return browser.messages.getRaw(nativeId);
  const full = await browser.messages.getFull(nativeId);
  const extracted = extractPlainText(full);
  if (!extracted) return "";
  if (format === "markdown") return extracted.format === "html" ? htmlToMarkdown(extracted.text) : stripInvisibleAndBidi(extracted.text);
  return sanitizeBody(extracted.text, extracted.format);
}

export async function messagesGet(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(MESSAGE_GET_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `message get 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as MessageGetBody;
  const nativeId = resolveMessageNativeId(parsed.messageRef, context);

  let format = parsed.format ?? "text";
  let offsetBytes = 0;
  if (parsed.cursor) {
    const cursorPayload = resolveRef<BodyCursorPayload>("cursor", parsed.cursor, context);
    if (cursorPayload.messageNativeId !== nativeId) throw new MailAdapterError("E_VALIDATION", "cursor 与 messageRef 不匹配");
    if (parsed.format && parsed.format !== cursorPayload.format) throw new MailAdapterError("E_VALIDATION", "cursor 与请求的 format 不匹配，续取必须使用同一 format");
    format = cursorPayload.format;
    offsetBytes = cursorPayload.offsetBytes;
  }
  const maxBytes = parsed.maxBytes ?? DEFAULT_MAX_BYTES;

  const header = await requireHeader(nativeId);
  const fullText = await readBodyText(nativeId, format);
  const truncated = truncateByBytes(fullText, maxBytes, offsetBytes);

  const accountNativeId = header.accountId ?? header.folder?.accountId;
  const out: Record<string, unknown> = {
    messageRef: parsed.messageRef,
    headerMessageId: header.headerMessageId,
    subject: stripInvisibleAndBidi(header.subject ?? ""),
    from: maskAddressDisplay(parseAuthorDisplay(header.author)),
    to: header.recipients.map((address) => maskAddressDisplay(parseAuthorDisplay(address))),
    cc: header.ccList.map((address) => maskAddressDisplay(parseAuthorDisplay(address))),
    receivedAt: toDate(header.date).toISOString(),
    flags: { read: header.read, flagged: header.flagged, junk: header.junk, new: header.new },
    content: truncated.content,
    contentFormat: format,
    originalBytes: truncated.originalBytes,
    returnedBytes: truncated.returnedBytes,
    truncated: truncated.truncated,
  };
  if (accountNativeId) out.accountRef = issueRef("acc", context, { accountNativeId });
  if (header.folder) out.folderRef = issueRef("folder", context, { accountNativeId: accountNativeId ?? header.folder.accountId, folderNativeId: header.folder.id } satisfies FolderRefPayload);
  if (truncated.truncated && truncated.nextOffsetBytes !== undefined) {
    out.nextCursor = issueRef("cursor", context, { messageNativeId: nativeId, format, offsetBytes: truncated.nextOffsetBytes } satisfies BodyCursorPayload);
  }
  return out;
}

// ---------------------------------------------------------------------------
// message open
// ---------------------------------------------------------------------------

const MESSAGE_OPEN_SCHEMA: JsonSchema = {
  type: "object",
  properties: { messageRef: opaqueRefSchema("msg") },
  required: ["messageRef"],
};

interface MessageOpenBody { messageRef: string }

export async function messagesOpen(body: unknown, context: MailAdapterContext): Promise<{ opened: true; tabId?: number; windowId?: number }> {
  const result = validate(MESSAGE_OPEN_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `message open 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as MessageOpenBody;
  const nativeId = resolveMessageNativeId(parsed.messageRef, context);
  await requireHeader(nativeId);
  const tab = await browser.messageDisplay.open({ messageId: nativeId, location: "tab" });
  const out: { opened: true; tabId?: number; windowId?: number } = { opened: true };
  if (tab.tabId !== undefined) out.tabId = tab.tabId;
  if (tab.windowId !== undefined) out.windowId = tab.windowId;
  return out;
}
