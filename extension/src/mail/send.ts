// draft send --prepare / --confirm —— 外发两阶段确认（docs/04 状态机
// Draft → Prepared → Confirmed → Sent/Failed；docs/07 §草稿优先体验
// 6-8 步）。
//
// 设计意图（Task #30 明确要求："发送必须绑定活着的 compose tab 最新
// revision；写超时不得自动重试"）：
// - prepare 与 confirm 都要求 draftRef 绑定的 compose tab 仍然存活，并且都
//   用 `compose.getComposeDetails(tabId)` 读取**实时**未保存状态（而不是
//   上一次 saveMessage() 落盘的快照）——这是"最新 revision"的字面含义：
//   即使用户在 prepare 之后、confirm 之前又改了几个字但还没按 Ctrl+S，
//   confirm 阶段重新计算的摘要也会反映这个变化，从而正确触发
//   E_CONFIRMATION_REQUIRED，而不是拿一份过期快照去发送。
// - confirm 的 confirm ref 无论匹配成功还是失败都立即一次性消费（见下方
//   注释），因此天然满足"不自动重试"：CLI 侧超时后即使用户手动重跑同一条
//   confirm 命令，第二次调用只会拿到 E_CONFIRMATION_REQUIRED（token 已被
//   消费），绝不会造成第二次真实发送。
// - `compose.send`（Task #44，0.4.0）是 manifest.json 的可选权限
//   （`optional_permissions`，不在常驻 `permissions` 里），默认未授予：
//   用户必须在扩展 options 页面显式勾选"外发确认"能力，经浏览器原生
//   `permissions.request()` 提示同意后才会真正持有。`draftsSendConfirm`
//   在调用 `sendMessage()` 之前，额外用 `browser.permissions.contains()`
//   独立确认这个浏览器层权限确实存在——不信任"capability 系统（下面的
//   `context.capability` 门禁，发生在更早的 route dispatch 阶段）已经放行"
//   就等于"浏览器权限也一定还在"：这两套状态可能互相漂移（例如用户绕过
//   options 页面、直接在 Thunderbird 自身插件管理页面撤销了这个可选权限），
//   缺权限时精确返回 `E_POLICY_DENIED`（不是 `E_INTERNAL`——那个错误码
//   语义上是"执行中出了意外"，而这里是"从一开始就不该执行"，两者对调用方
//   的含义不同：前者可能意味着"重试也没用，需要用户重新授权"，后者容易被
//   误当成瞬时故障）。
import { recordAudit } from "../audit.js";
import { stableStringify } from "../policy.js";
import type { JsonSchema } from "../schema.js";
import { ISO_TIMESTAMP_SCHEMA, validate } from "../schema.js";
import { stripInvisibleAndBidi } from "./sanitize.js";
import { recordOperation } from "./operations.js";
import { MailAdapterError, issueRef, mailRefStore, resolveRef, REF_TTL_MS, type MailAdapterContext } from "./state.js";

/** 与 extension/manifest.json 的 `optional_permissions` 条目、extension/src/options.ts 的同名常量是同一份契约的镜像。 */
const COMPOSE_SEND_PERMISSION = "compose.send";

interface DraftRefPayload { messageNativeId?: number; composeTabId?: number }

interface ConfirmPayload {
  readonly composeTabId: number;
  readonly messageNativeId?: number;
  readonly draftRef: string;
  readonly revision: string;
  readonly recipientDigest: string;
  readonly subjectDigest: string;
  readonly attachmentDigest: string;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

interface DigestSet {
  readonly revision: string;
  readonly recipientDigest: string;
  readonly subjectDigest: string;
  readonly attachmentDigest: string;
}

async function computeDigests(details: ComposeDetails): Promise<DigestSet> {
  const recipients = { to: details.to ?? [], cc: details.cc ?? [], bcc: details.bcc ?? [] };
  const [recipientDigest, subjectDigest, attachmentDigest] = await Promise.all([
    sha256Hex(stableStringify(recipients)),
    sha256Hex(stableStringify(details.subject ?? "")),
    sha256Hex(stableStringify(details.attachments ?? [])),
  ]);
  const revision = await sha256Hex(stableStringify({
    ...recipients,
    subject: details.subject ?? "",
    body: details.plainTextBody ?? details.body ?? "",
    identityId: details.identityId ?? "",
  }));
  return { revision: `sha256:${revision}`, recipientDigest: `sha256:${recipientDigest}`, subjectDigest: `sha256:${subjectDigest}`, attachmentDigest: `sha256:${attachmentDigest}` };
}

// ---------------------------------------------------------------------------
// drafts.send.prepare
// ---------------------------------------------------------------------------

const SEND_PREPARE_SCHEMA: JsonSchema = {
  type: "object",
  properties: { draftRef: { type: "string", pattern: /^draft_[A-Za-z0-9_-]{16,128}$/, maxLength: 8 + 128 } },
  required: ["draftRef"],
};

export async function draftsSendPrepare(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(SEND_PREPARE_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `draft send prepare 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as { draftRef: string };

  const draftPayload = resolveRef<DraftRefPayload>("draft", parsed.draftRef, context);
  if (!(await isTabAlive(draftPayload.composeTabId))) {
    throw new MailAdapterError("E_VALIDATION", "草稿的撰写窗口已关闭，无法生成外发确认；请先执行 draft open");
  }
  const composeTabId = draftPayload.composeTabId!;
  const details = await browser.compose.getComposeDetails(composeTabId);
  const digests = await computeDigests(details);

  const confirmPayload: ConfirmPayload = { composeTabId, draftRef: parsed.draftRef, ...digests, ...(draftPayload.messageNativeId !== undefined ? { messageNativeId: draftPayload.messageNativeId } : {}) };
  const confirmationId = mailRefStore.issue("confirm", context.clientId, context.pairingEpoch, confirmPayload, REF_TTL_MS.confirm);

  recordAudit({ routeId: "drafts.send.prepare", capability: context.capability, clientId: context.clientId, outcome: "success" });
  return {
    confirmationId,
    draftRef: parsed.draftRef,
    ...digests,
    to: details.to ?? [],
    cc: details.cc ?? [],
    bcc: details.bcc ?? [],
    subject: stripInvisibleAndBidi(details.subject ?? ""),
    expiresAt: new Date(Date.now() + REF_TTL_MS.confirm).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// drafts.send.confirm
// ---------------------------------------------------------------------------

const SEND_CONFIRM_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    draftRef: { type: "string", pattern: /^draft_[A-Za-z0-9_-]{16,128}$/, maxLength: 8 + 128 },
    confirmationId: { type: "string", pattern: /^confirm_[A-Za-z0-9_-]{16,128}$/, maxLength: 8 + 128 },
    draftRevision: { type: "string", maxLength: 128 },
    confirmedAt: ISO_TIMESTAMP_SCHEMA,
  },
  required: ["draftRef", "confirmationId", "draftRevision"],
};

export async function draftsSendConfirm(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(SEND_CONFIRM_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `draft send confirm 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as { draftRef: string; confirmationId: string; draftRevision: string; confirmedAt?: string };

  // Task #44：浏览器层权限门禁放在最前面，且刻意在消费 confirmationId 之前
  // 检查——缺权限时这条一次性 confirmationId 不应该被白白烧掉，用户在
  // options 页面补授权后应该能直接重试同一个 confirmationId，不必重新跑
  // 一遍 --prepare。这道检查独立于（并且晚于）route dispatch 阶段已经做过
  // 的 mail.send-confirmed.v1 capability 门禁——两者互不信任对方已经生效。
  if (!(await browser.permissions.contains({ permissions: [COMPOSE_SEND_PERMISSION] }))) {
    recordAudit({ routeId: "drafts.send.confirm", capability: context.capability, clientId: context.clientId, outcome: "denied", reason: "send-permission-missing" });
    throw new MailAdapterError("E_POLICY_DENIED", "浏览器未授予 compose.send 权限，外发确认能力当前物理不可用；请在扩展 options 页面显式启用外发确认能力");
  }

  const nowMs = Date.now();
  const payload = mailRefStore.resolve(parsed.confirmationId, "confirm", { clientId: context.clientId, pairingEpoch: context.pairingEpoch, nowMs }) as ConfirmPayload | undefined;
  // 无论后续匹配是否成功，这个 confirmationId 都只允许被兑现一次：找到即立刻消费，
  // 防止调用方拿同一个 confirmationId 反复试探不同的 draftRevision。
  if (payload) mailRefStore.consume(parsed.confirmationId);

  if (!payload || payload.draftRef !== parsed.draftRef) {
    recordAudit({ routeId: "drafts.send.confirm", capability: context.capability, clientId: context.clientId, outcome: "denied", reason: "confirm-not-found" });
    throw new MailAdapterError("E_CONFIRMATION_REQUIRED", "外发确认不存在或已失效，请重新执行 draft send --prepare");
  }
  if (payload.revision !== parsed.draftRevision) {
    recordAudit({ routeId: "drafts.send.confirm", capability: context.capability, clientId: context.clientId, outcome: "denied", reason: "revision-mismatch" });
    throw new MailAdapterError("E_CONFIRMATION_REQUIRED", "草稿自 prepare 后已变化，请重新执行 draft send --prepare");
  }
  if (!(await isTabAlive(payload.composeTabId))) {
    recordAudit({ routeId: "drafts.send.confirm", capability: context.capability, clientId: context.clientId, outcome: "denied", reason: "tab-closed" });
    throw new MailAdapterError("E_CONFIRMATION_REQUIRED", "撰写窗口在确认前已关闭，请重新执行 draft open 与 draft send --prepare");
  }

  const details = await browser.compose.getComposeDetails(payload.composeTabId);
  const liveDigests = await computeDigests(details);
  if (liveDigests.revision !== payload.revision || liveDigests.recipientDigest !== payload.recipientDigest || liveDigests.subjectDigest !== payload.subjectDigest || liveDigests.attachmentDigest !== payload.attachmentDigest) {
    recordAudit({ routeId: "drafts.send.confirm", capability: context.capability, clientId: context.clientId, outcome: "denied", reason: "live-digest-mismatch" });
    throw new MailAdapterError("E_CONFIRMATION_REQUIRED", "草稿在确认前又发生了变化，请重新执行 draft send --prepare");
  }

  const operationId = issueRef("op", context, {});
  try {
    await browser.compose.sendMessage(payload.composeTabId, { mode: "sendNow" });
  } catch (error) {
    recordOperation(operationId, "drafts.send", [parsed.draftRef], context, "failed");
    recordAudit({ routeId: "drafts.send.confirm", capability: context.capability, clientId: context.clientId, outcome: "error", reason: "send-failed" });
    // Task #43 收敛：operationId 通过结构化 details 透传（见 state.ts 的
    // MailAdapterError/MailErrorDetails），message 只做人类可读文案，不再
    // 是"文案里藏着一个隐式协议、谁 regex 谁绑定"的设计——调用方需要程序化
    // 拿到 operationId 时读 error.details.operationId，不应该解析 message。
    throw new MailAdapterError("E_INTERNAL", "外发失败：请通过 operations get 查询最新状态，不要自动重试", { operationId });
  }

  recordOperation(operationId, "drafts.send", [parsed.draftRef], context, "sent");
  recordAudit({ routeId: "drafts.send.confirm", capability: context.capability, clientId: context.clientId, outcome: "success" });
  return { operationId, sent: true, confirmationId: parsed.confirmationId, sentAt: new Date().toISOString() };
}
