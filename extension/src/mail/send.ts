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
// - `compose.send` 权限本轮**未**在 manifest.json 申请（见 mail-api.d.ts
//   顶部说明与 manifest.json 自身注释），因此下面对 `sendMessage()` 的调用
//   在真实 Thunderbird 环境中会因权限缺失而失败——这是"禁止真实发送"的
//   物理保证，不只是本文件的代码逻辑；一旦外发专项评审通过、集成阶段加入该
//   权限，这里不需要任何改动即可开始真正生效。
import { recordAudit } from "../audit.js";
import { stableStringify } from "../policy.js";
import type { JsonSchema } from "../schema.js";
import { ISO_TIMESTAMP_SCHEMA, validate } from "../schema.js";
import { stripInvisibleAndBidi } from "./sanitize.js";
import { recordOperation } from "./operations.js";
import { MailAdapterError, issueRef, mailRefStore, resolveRef, REF_TTL_MS, type MailAdapterContext } from "./state.js";

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
    // Task #42 收敛：错误消息必须真的带上 operationId，否则"请通过 operations
    // get 查询最新状态"这句提示没有任何东西可查——MailAdapterError 目前只有
    // code/message 两个字段（没有结构化 details 透传通道，那需要改
    // background.ts/api.js 的 failOperation 签名，不在本任务改动范围内）。
    // 这里把 operationId 写进 message 纯粹是给人看的诊断信息（供用户/Skill
    // 复制粘贴去手动查询），不是稳定的机器可解析协议——message 文案措辞
    // 未来可以自由调整，不构成对调用方的兼容性承诺；真正需要程序化拿到
    // operationId 的场景，应该等结构化 details 通道落地后再由 CLI/平台层
    // 消费，而不是依赖 message 里的固定前缀。
    throw new MailAdapterError("E_INTERNAL", `外发失败（operationId=${operationId}）：请通过 operations get 查询最新状态，不要自动重试`);
  }

  recordOperation(operationId, "drafts.send", [parsed.draftRef], context, "sent");
  recordAudit({ routeId: "drafts.send.confirm", capability: context.capability, clientId: context.clientId, outcome: "success" });
  return { operationId, sent: true, confirmationId: parsed.confirmationId, sentAt: new Date().toISOString() };
}
