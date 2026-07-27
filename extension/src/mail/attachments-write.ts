// attachments.save / attachments.fetch —— 附件保存的授权与分块拉取半（Task
// #30/mail-write），落盘/no-clobber/敏感路径/符号链接拒绝完全由 CLI（Task
// #36）负责。
//
// 契约边界（team-lead/Opus 裁决，2026-07-27，与 `src/contracts/routes.ts`
// 冻结的常量/文本逐字对齐）：
// - `attachments.save` 请求体只接受 `attachmentRef`，绝不接收也不解释任何
//   本机文件系统路径字段；扩展只按 attachmentRef 授权、读取原始字节校验
//   大小并计算摘要，返回元数据 + 一次性 fetch token。
// - `attachments.fetch` 是 JSON 内联 base64 分块（不是原始二进制 HTTP
//   响应），cursor 严格单调续取，乱序/重放拒绝。
//
import { recordAudit } from "../audit.js";
import type { JsonSchema } from "../schema.js";
import { opaqueRefSchema, validate } from "../schema.js";
import { MailAdapterError, mailRefStore, resolveRef, REF_TTL_MS, type MailAdapterContext } from "./state.js";

// 下面三个常量镜像 `src/contracts/routes.ts` 的同名冻结值——按本仓库既有
// 约定（见 refs.ts/schema.ts 顶部注释），extension/ 下的代码不跨
// tsconfig rootDir 导入 `src/contracts/*`，只能手工镜像并靠测试保持同步。
// 修改任一处都必须同步另一处。
const ATTACHMENT_FETCH_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_FETCH_MAX_CHUNK_ENCODED_BYTES = 512 * 1024;
const ATTACHMENT_FETCH_TOKEN_TTL_MS = 2 * 60 * 1000;

interface AttachmentRefPayload { messageNativeId: number; partName: string }

/** fetch token 复用 "attachment" ref kind（避免新增 RefKind，见 refs.ts 是冻结契约），用 `purpose` 字段与稳定的 attachmentRef 区分，防止两者被互相冒用。 */
interface FetchTokenPayload {
  purpose: "fetch";
  messageNativeId: number;
  partName: string;
  totalBytes: number;
  contentType: string;
  name: string;
}

/** cursor 同样复用既有 "cursor" ref kind（read 域已建立的续取语义），payload 用 `purpose` 区分并绑定具体 fetchToken + 期望的下一个偏移量。 */
interface FetchCursorPayload {
  purpose: "attachment-fetch";
  fetchToken: string;
  expectedOffset: number;
}

interface BufferedAttachment {
  readonly bytes: Uint8Array;
  readonly name: string;
  readonly contentType: string;
  nextExpectedOffset: number;
}

/** fetchToken -> 已读入内存的原始字节 + 续取状态；save 阶段写入，fetch 阶段消费，token 过期/一次性消费/被新 save 作废时清理。 */
const bufferedByToken = new Map<string, BufferedAttachment>();
/** `${messageNativeId}:${partName}` -> 当前仍有效的 fetchToken；用于"每次 save 作废旧 token"。 */
const outstandingTokenByAttachment = new Map<string, string>();

function attachmentKey(messageNativeId: number, partName: string): string {
  return `${messageNativeId}:${partName}`;
}

function invalidateOutstandingToken(key: string): void {
  const oldToken = outstandingTokenByAttachment.get(key);
  if (!oldToken) return;
  mailRefStore.consume(oldToken);
  bufferedByToken.delete(oldToken);
  outstandingTokenByAttachment.delete(key);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // 较新的 DOM lib 类型把 `BufferSource` 收紧为要求 `ArrayBufferView<ArrayBuffer>`
  // （不接受 `ArrayBufferLike`，理论上可能是 `SharedArrayBuffer`）；这里的
  // `bytes` 实际总是来自 `new Uint8Array(await file.arrayBuffer())`，backing
  // buffer 必然是普通 `ArrayBuffer`，`as BufferSource` 是如实反映运行时形状
  // 的窄化，不是绕过类型检查。
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** base64 编码：避免对大数组使用 `String.fromCharCode(...bytes)` 展开触发调用栈溢出，按固定块拼接二进制字符串后一次性 `btoa`。 */
function encodeBase64Chunk(bytes: Uint8Array): string {
  let binary = "";
  const BLOCK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += BLOCK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BLOCK));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// attachments.save
// ---------------------------------------------------------------------------

const ATTACHMENTS_SAVE_SCHEMA: JsonSchema = {
  type: "object",
  properties: { attachmentRef: opaqueRefSchema("attachment") },
  required: ["attachmentRef"],
};

export async function attachmentsSave(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(ATTACHMENTS_SAVE_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `attachments save 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as { attachmentRef: string };

  const { messageNativeId, partName } = resolveRef<AttachmentRefPayload>("attachment", parsed.attachmentRef, context);
  const header = await browser.messages.get(messageNativeId).catch(() => undefined);
  if (!header) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  const attachments = await browser.messages.listAttachments(messageNativeId);
  const attachment = attachments.find((candidate) => candidate.partName === partName);
  if (!attachment) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");

  if (attachment.size > ATTACHMENT_FETCH_MAX_TOTAL_BYTES) {
    recordAudit({ routeId: "attachments.save", capability: context.capability, clientId: context.clientId, outcome: "denied", reason: "too-large" });
    throw new MailAdapterError("E_POLICY_DENIED", `附件大小超过单次可拉取上限（${ATTACHMENT_FETCH_MAX_TOTAL_BYTES} 字节），拒绝签发 fetch token`);
  }

  const file = await browser.messages.getAttachmentFile(messageNativeId, partName);
  const buffer = new Uint8Array(await file.arrayBuffer());
  if (buffer.byteLength > ATTACHMENT_FETCH_MAX_TOTAL_BYTES) {
    // 防御性二次校验：listAttachments 声明的 size 与实际读到的字节数可能不一致（没有官方保证一致，见 docs/09 §A.5）。
    recordAudit({ routeId: "attachments.save", capability: context.capability, clientId: context.clientId, outcome: "denied", reason: "too-large-actual" });
    throw new MailAdapterError("E_POLICY_DENIED", `附件实际字节数超过单次可拉取上限（${ATTACHMENT_FETCH_MAX_TOTAL_BYTES} 字节），拒绝签发 fetch token`);
  }
  const digest = await sha256Hex(buffer);

  const key = attachmentKey(messageNativeId, partName);
  invalidateOutstandingToken(key);

  const contentType = attachment.contentType || "application/octet-stream";
  const name = attachment.name ?? "";
  const fetchTokenPayload: FetchTokenPayload = { purpose: "fetch", messageNativeId, partName, totalBytes: buffer.byteLength, contentType, name };
  const fetchToken = mailRefStore.issue("attachment", context.clientId, context.pairingEpoch, fetchTokenPayload, ATTACHMENT_FETCH_TOKEN_TTL_MS);
  bufferedByToken.set(fetchToken, { bytes: buffer, name, contentType, nextExpectedOffset: 0 });
  outstandingTokenByAttachment.set(key, fetchToken);

  recordAudit({ routeId: "attachments.save", capability: context.capability, clientId: context.clientId, outcome: "success", sizeBytes: buffer.byteLength });
  return {
    attachmentRef: parsed.attachmentRef,
    name,
    contentType,
    size: buffer.byteLength,
    digest: `sha256:${digest}`,
    fetchToken,
    expiresAt: new Date(Date.now() + ATTACHMENT_FETCH_TOKEN_TTL_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// attachments.fetch
// ---------------------------------------------------------------------------

const ATTACHMENTS_FETCH_SCHEMA: JsonSchema = {
  type: "object",
  properties: { fetchToken: opaqueRefSchema("attachment"), cursor: opaqueRefSchema("cursor") },
  required: ["fetchToken"],
};

/** base64 编码后不超过 ATTACHMENT_FETCH_MAX_CHUNK_ENCODED_BYTES 的最大原始字节数：向下取整到 3 的倍数，保证整块编码无 padding 膨胀误差。 */
const RAW_CHUNK_BYTES = Math.floor(ATTACHMENT_FETCH_MAX_CHUNK_ENCODED_BYTES / 4) * 3;

export async function attachmentsFetch(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(ATTACHMENTS_FETCH_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `attachments fetch 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as { fetchToken: string; cursor?: string };

  const nowMs = Date.now();
  const tokenPayload = mailRefStore.resolve(parsed.fetchToken, "attachment", { clientId: context.clientId, pairingEpoch: context.pairingEpoch, nowMs }) as FetchTokenPayload | undefined;
  if (!tokenPayload || tokenPayload.purpose !== "fetch") throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  const buffered = bufferedByToken.get(parsed.fetchToken);
  if (!buffered) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");

  let expectedOffset: number;
  if (parsed.cursor === undefined) {
    if (buffered.nextExpectedOffset !== 0) {
      throw new MailAdapterError("E_VALIDATION", "缺少 cursor：本次拉取不是该 fetchToken 的第一段，乱序请求被拒绝");
    }
    expectedOffset = 0;
  } else {
    const cursorPayload = mailRefStore.resolve(parsed.cursor, "cursor", { clientId: context.clientId, pairingEpoch: context.pairingEpoch, nowMs }) as FetchCursorPayload | undefined;
    if (!cursorPayload || cursorPayload.purpose !== "attachment-fetch") throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
    if (cursorPayload.fetchToken !== parsed.fetchToken || cursorPayload.expectedOffset !== buffered.nextExpectedOffset) {
      throw new MailAdapterError("E_VALIDATION", "cursor 与当前拉取进度不匹配，乱序或重放请求被拒绝");
    }
    mailRefStore.consume(parsed.cursor);
    expectedOffset = cursorPayload.expectedOffset;
  }

  const chunk = buffered.bytes.subarray(expectedOffset, expectedOffset + RAW_CHUNK_BYTES);
  const chunkBase64 = encodeBase64Chunk(chunk);
  const nextOffset = expectedOffset + chunk.length;
  const done = nextOffset >= buffered.bytes.length;

  const key = attachmentKey(tokenPayload.messageNativeId, tokenPayload.partName);
  if (done) {
    mailRefStore.consume(parsed.fetchToken);
    bufferedByToken.delete(parsed.fetchToken);
    if (outstandingTokenByAttachment.get(key) === parsed.fetchToken) outstandingTokenByAttachment.delete(key);
  } else {
    buffered.nextExpectedOffset = nextOffset;
  }

  recordAudit({ routeId: "attachments.fetch", capability: context.capability, clientId: context.clientId, outcome: "success", offsetBytes: expectedOffset, done });

  const out: Record<string, unknown> = {
    name: buffered.name,
    contentType: buffered.contentType,
    chunkBase64,
    offset: expectedOffset,
    chunkBytes: chunk.length,
    totalBytes: buffered.bytes.length,
    done,
  };
  if (!done) {
    out.nextCursor = mailRefStore.issue("cursor", context.clientId, context.pairingEpoch, { purpose: "attachment-fetch", fetchToken: parsed.fetchToken, expectedOffset: nextOffset } satisfies FetchCursorPayload, REF_TTL_MS.cursor);
  }
  return out;
}
