// draft create / update / open —— 草稿域（docs/07 §草稿优先体验：1. 生成文本
// 并说明 identity 2. CLI 创建 draft 3. 返回 draft ref、收件人、主题、正文
// 摘要、附件摘要 4. 默认在撰写窗口打开）。
//
// 设计意图：draftRef 绑定的是"一个仍然打开着的 Thunderbird 撰写窗口"
// （`composeTabId`），而不仅仅是一个已保存草稿的原生消息 id——`send.ts` 的
// prepare 阶段需要读取"活着的 compose tab 最新 revision"（Task #30 明确
// 要求），这只能通过 `compose.getComposeDetails(tabId)` 拿到实时未保存状态，
// 不能依赖上一次 saveMessage() 落盘的快照。因此 create/update/open 三者都
// 以"确保有一个存活的 compose tab"为核心动作，`messageNativeId` 只是
// "最近一次成功保存"的参考值，供展示/兼容用，不是权威状态源。
//
// 已知不确定性（架构师报告 §A.5，需要真实 Thunderbird 环境验证，本轮无法
// 核实）：`compose.beginNew(messageId)` official 语义是"以该草稿为蓝本编辑
// 为一封新邮件"，不保证是"原地继续编辑同一封草稿"——如果 compose tab 已被
// 用户手动关闭，`draftsOpen`/`draftsUpdate` 走的重新打开路径存在产生重复
// 草稿的风险，见下方 reopenViaTemplate() 的注释。
//
// 本轮范围（与 route 冻结的 8 KiB body 上限一致）：草稿正文是纯文本，不支持
// 在 create/update 里内联新增附件——`compose.addAttachment` 需要传入实际
// 文件字节，而附件写入路径本身按 team-lead/Opus 裁决完全排除在扩展侧之外
// （见 attachments-write.ts 头部注释），本轮草稿因此不提供"新增附件"能力。
import { recordAudit } from "../audit.js";
import type { JsonSchema } from "../schema.js";
import { validate } from "../schema.js";
import { stripInvisibleAndBidi } from "./sanitize.js";
import { MailAdapterError, issueRef, resolveRef, type MailAdapterContext } from "./state.js";

interface IdentityRefPayload { accountNativeId: string; identityNativeId: string }
interface DraftRefPayload { messageNativeId?: number; composeTabId?: number }

const EMAIL_ARRAY_SCHEMA = { type: "array", items: { type: "string", maxLength: 320 }, maxItems: 50 } as const;

const DRAFT_CREATE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    identityRef: { type: "string", pattern: /^identity_[A-Za-z0-9_-]{16,128}$/, maxLength: 8 + 128 },
    to: EMAIL_ARRAY_SCHEMA,
    cc: EMAIL_ARRAY_SCHEMA,
    bcc: EMAIL_ARRAY_SCHEMA,
    subject: { type: "string", maxLength: 998 },
    body: { type: "string", maxLength: 6000 },
  },
  required: ["identityRef"],
};

interface DraftFields {
  identityRef?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
}

function toComposeDetails(fields: DraftFields, identityNativeId?: string): ComposeDetails {
  const details: ComposeDetails = { isPlainText: true };
  if (identityNativeId) details.identityId = identityNativeId;
  if (fields.to) details.to = fields.to;
  if (fields.cc) details.cc = fields.cc;
  if (fields.bcc) details.bcc = fields.bcc;
  if (fields.subject !== undefined) details.subject = stripInvisibleAndBidi(fields.subject);
  if (fields.body !== undefined) details.body = stripInvisibleAndBidi(fields.body);
  return details;
}

function bodyPreview(body?: string): string {
  if (!body) return "";
  const collapsed = stripInvisibleAndBidi(body).replaceAll(/\s+/g, " ").trim();
  return collapsed.length <= 240 ? collapsed : `${collapsed.slice(0, 240)}…`;
}

/** `saveMessage()` 的 `messages` 数组在 TB<142 上可能多于一个（FCC 配置影响），不得假设 `messages[0]` 唯一；取不到任何元素时视为保存失败。 */
function firstSavedMessage(saved: ComposeSaveResult): MessageHeader {
  const first = saved.messages[0];
  if (!first) throw new MailAdapterError("E_INTERNAL", "草稿保存未返回任何消息记录");
  return first;
}

/** `exactOptionalPropertyTypes` 下不能把 `string[] | undefined` 直接赋给可选属性——只在字段确有值时才放进结果对象。 */
function composeDetailsToFields(details: ComposeDetails): DraftFields {
  const body = details.plainTextBody ?? details.body;
  return {
    ...(details.to !== undefined ? { to: details.to } : {}),
    ...(details.cc !== undefined ? { cc: details.cc } : {}),
    ...(details.bcc !== undefined ? { bcc: details.bcc } : {}),
    ...(details.subject !== undefined ? { subject: details.subject } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

async function isTabAlive(tabId: number | undefined): Promise<boolean> {
  if (tabId === undefined) return false;
  try {
    await browser.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function draftResponse(draftRef: string, fields: DraftFields, messageNativeId: number | undefined, composeTabId: number): Record<string, unknown> {
  return {
    draftRef,
    ...(fields.to ? { to: fields.to } : {}),
    ...(fields.cc ? { cc: fields.cc } : {}),
    ...(fields.bcc ? { bcc: fields.bcc } : {}),
    ...(fields.subject !== undefined ? { subject: stripInvisibleAndBidi(fields.subject) } : {}),
    bodyPreview: bodyPreview(fields.body),
    composeTabId,
    ...(messageNativeId !== undefined ? { savedMessageId: messageNativeId } : {}),
  };
}

// ---------------------------------------------------------------------------
// draft create
// ---------------------------------------------------------------------------

export async function draftsCreate(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(DRAFT_CREATE_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `draft create 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as DraftFields & { identityRef: string };

  const { identityNativeId } = resolveRef<IdentityRefPayload>("identity", parsed.identityRef, context);
  const tab = await browser.compose.beginNew(toComposeDetails(parsed, identityNativeId));
  const saved = await browser.compose.saveMessage(tab.id, { mode: "draft" });
  const messageNativeId = firstSavedMessage(saved).id;

  const draftRef = issueRef("draft", context, { messageNativeId, composeTabId: tab.id } satisfies DraftRefPayload);
  recordAudit({ routeId: "drafts.create", capability: context.capability, clientId: context.clientId, outcome: "success" });
  return draftResponse(draftRef, parsed, messageNativeId, tab.id);
}

// ---------------------------------------------------------------------------
// draft update
// ---------------------------------------------------------------------------

const DRAFT_UPDATE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    draftRef: { type: "string", pattern: /^draft_[A-Za-z0-9_-]{16,128}$/, maxLength: 8 + 128 },
    to: EMAIL_ARRAY_SCHEMA,
    cc: EMAIL_ARRAY_SCHEMA,
    bcc: EMAIL_ARRAY_SCHEMA,
    subject: { type: "string", maxLength: 998 },
    body: { type: "string", maxLength: 6000 },
  },
  required: ["draftRef"],
};

export async function draftsUpdate(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(DRAFT_UPDATE_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `draft update 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as DraftFields & { draftRef: string };
  if (parsed.to === undefined && parsed.cc === undefined && parsed.bcc === undefined && parsed.subject === undefined && parsed.body === undefined) {
    throw new MailAdapterError("E_VALIDATION", "draft update 至少需要指定一个待更新字段");
  }

  const payload = resolveRef<DraftRefPayload>("draft", parsed.draftRef, context);
  if (!(await isTabAlive(payload.composeTabId))) {
    throw new MailAdapterError("E_VALIDATION", "草稿的撰写窗口已关闭，请先执行 draft open 重新打开后再更新");
  }
  const composeTabId = payload.composeTabId!;

  const current = await browser.compose.getComposeDetails(composeTabId);
  await browser.compose.setComposeDetails(composeTabId, toComposeDetails(parsed));
  const saved = await browser.compose.saveMessage(composeTabId, { mode: "draft" });
  const messageNativeId = firstSavedMessage(saved).id;

  const mergedTo = parsed.to ?? current.to;
  const mergedCc = parsed.cc ?? current.cc;
  const mergedBcc = parsed.bcc ?? current.bcc;
  const mergedSubject = parsed.subject ?? current.subject;
  const mergedBody = parsed.body ?? current.plainTextBody ?? current.body;
  const merged: DraftFields = {
    ...(mergedTo !== undefined ? { to: mergedTo } : {}),
    ...(mergedCc !== undefined ? { cc: mergedCc } : {}),
    ...(mergedBcc !== undefined ? { bcc: mergedBcc } : {}),
    ...(mergedSubject !== undefined ? { subject: mergedSubject } : {}),
    ...(mergedBody !== undefined ? { body: mergedBody } : {}),
  };
  const draftRef = issueRef("draft", context, { messageNativeId, composeTabId } satisfies DraftRefPayload);
  recordAudit({ routeId: "drafts.update", capability: context.capability, clientId: context.clientId, outcome: "success" });
  return draftResponse(draftRef, merged, messageNativeId, composeTabId);
}

// ---------------------------------------------------------------------------
// draft open
// ---------------------------------------------------------------------------

const DRAFT_OPEN_SCHEMA: JsonSchema = {
  type: "object",
  properties: { draftRef: { type: "string", pattern: /^draft_[A-Za-z0-9_-]{16,128}$/, maxLength: 8 + 128 } },
  required: ["draftRef"],
};

export async function draftsOpen(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(DRAFT_OPEN_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `draft open 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as { draftRef: string };

  const payload = resolveRef<DraftRefPayload>("draft", parsed.draftRef, context);
  if (await isTabAlive(payload.composeTabId)) {
    const composeTabId = payload.composeTabId!;
    const details = await browser.compose.getComposeDetails(composeTabId);
    const draftRef = issueRef("draft", context, payload);
    recordAudit({ routeId: "drafts.open", capability: context.capability, clientId: context.clientId, outcome: "success", detail: "reused-tab" });
    return draftResponse(draftRef, composeDetailsToFields(details), payload.messageNativeId, composeTabId);
  }

  if (payload.messageNativeId === undefined) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  // reopenViaTemplate：compose tab 已关闭，唯一可用的官方入口是
  // `beginNew(messageId)`——按架构师报告的措辞，这"以草稿为蓝本编辑为一封
  // 新邮件"，不保证原地续编；本轮无法在真实 Thunderbird 环境验证是否会产生
  // 重复草稿（旧的已保存草稿消息可能仍留在 Drafts 文件夹）。这是已知、
  // 文档化的行为不确定性，不是本次实现遗漏。
  const tab = await browser.compose.beginNew(payload.messageNativeId);
  const details = await browser.compose.getComposeDetails(tab.id);
  const draftRef = issueRef("draft", context, { messageNativeId: payload.messageNativeId, composeTabId: tab.id } satisfies DraftRefPayload);
  recordAudit({ routeId: "drafts.open", capability: context.capability, clientId: context.clientId, outcome: "success", detail: "reopened-from-template" });
  return draftResponse(draftRef, composeDetailsToFields(details), payload.messageNativeId, tab.id);
}
