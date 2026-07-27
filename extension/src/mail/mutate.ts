// message mark / move / trash —— 可逆邮件操作（docs/07 风险分级"可逆"档：
// 先记录原状态，执行后给撤销信息）。
//
// 设计意图：三者共享同一套"先快照原状态、再执行、最后签发 undo token +
// 登记 operation 记录"骨架，undo token 的 payload 由本文件决定形状，
// undo.ts 只负责按 kind 分支把它还原回去——两个文件对 payload 形状的约定
// 完全靠 TypeScript 类型对齐，不经过任何序列化协议。
//
// trash 明确只用 `messages.move()` 移进 `specialUse` 含 "trash" 的文件夹，
// 绝不调用 `messages.delete()`——manifest.json 也确实没有申请
// `messagesDelete` 权限，这是"不实现永久删除"决策的物理保证（docs/01
// 附录 A.1）。
import { recordAudit } from "../audit.js";
import { assertBatchLimit, idempotencyKey, mailIdempotencyCache, mailRateLimiter } from "../policy.js";
import type { JsonSchema } from "../schema.js";
import { boundedArraySchema, opaqueRefSchema, validate } from "../schema.js";
import { recordOperation } from "./operations.js";
import { MailAdapterError, issueRef, mailRefStore, resolveRef, REF_TTL_MS, type MailAdapterContext } from "./state.js";

interface MessageRefPayload { messageNativeId: number }
interface FolderRefPayload { accountNativeId: string; folderNativeId: unknown }

/**
 * schema 层的 messageRefs 数组上限，与 policy.ts 的 BATCH_THRESHOLDS
 * （mark 20 / move 10 / trash 5）刻意保持不同数值、不同职责（Task #42
 * 收敛，此前两者被设成相同值，导致"超过阈值"永远先被 schema 拦成
 * E_VALIDATION，policy.assertBatchLimit() 的 E_POLICY_DENIED 分支实际
 * 不可达——见 test/mail-write-integration.test.mjs 里记录的这处发现）。
 * 现在职责明确分层：schema 只挡住"body 里塞了几千个 ref 造成解析/内存
 * 开销"这类粗粒度 DoS，不表达任何业务语义；policy 的 20/10/5 才是唯一
 * 决定"这批操作是否需要更谨慎处理"的语义阈值，超过它精确返回
 * E_POLICY_DENIED（docs/03 退出码表的"策略拒绝"），不会被 schema 抢先
 * 拦截成语义不同的 E_VALIDATION（"参数错误"）。
 */
const SCHEMA_BATCH_DOS_CAP = 100;

/** undo.ts 唯一权威的 payload 形状；kind 决定还原动作，items 是逐条快照。 */
export interface UndoPayload {
  readonly kind: "mark" | "move" | "trash";
  readonly operationId: string;
  readonly items: ReadonlyArray<{
    readonly messageNativeId: number;
    readonly priorFlags?: { read?: boolean; flagged?: boolean; junk?: boolean; tags?: string[] };
    readonly priorFolderNativeId?: unknown;
  }>;
}

function resolveMessageNativeId(messageRef: string, context: MailAdapterContext): number {
  return resolveRef<MessageRefPayload>("msg", messageRef, context).messageNativeId;
}

async function requireHeader(nativeId: number): Promise<MessageHeader> {
  const header = await browser.messages.get(nativeId).catch(() => undefined);
  if (!header) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  return header;
}

/** 幂等命中时直接返回缓存结果；否则执行 fn 并把结果写入缓存后返回。fn 内部产生的一切副作用只在真正执行时发生一次。 */
async function withIdempotency<T>(routeId: string, context: MailAdapterContext, body: unknown, fn: () => Promise<T>): Promise<T> {
  mailRateLimiter.assertWithinLimit(context.clientId);
  const key = idempotencyKey(routeId, context.clientId, body);
  const cached = mailIdempotencyCache.get(key);
  if (cached !== undefined) return cached as T;
  const result = await fn();
  mailIdempotencyCache.set(key, result);
  return result;
}

function issueUndoAndRecord(kind: UndoPayload["kind"], operationKind: "messages.mark" | "messages.move" | "messages.trash", items: UndoPayload["items"], affected: readonly string[], context: MailAdapterContext): { operationId: string; undo: { token: string; expiresAt: string; summary: string } } {
  const operationId = issueRef("op", context, {});
  const undoToken = mailRefStore.issue("undo", context.clientId, context.pairingEpoch, { kind, operationId, items } satisfies UndoPayload, REF_TTL_MS.undo);
  recordOperation(operationId, operationKind, affected, context, "completed", undoToken);
  const summary = kind === "mark" ? `恢复 ${items.length} 封邮件的标记状态` : kind === "move" ? `将 ${items.length} 封邮件移回原文件夹` : `将 ${items.length} 封邮件移回原文件夹（撤销移入废纸篓）`;
  return { operationId, undo: { token: undoToken, expiresAt: new Date(Date.now() + REF_TTL_MS.undo).toISOString(), summary } };
}

// ---------------------------------------------------------------------------
// message mark
// ---------------------------------------------------------------------------

const MESSAGES_MARK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    messageRefs: boundedArraySchema(opaqueRefSchema("msg"), SCHEMA_BATCH_DOS_CAP),
    read: { type: "boolean" },
    flagged: { type: "boolean" },
    junk: { type: "boolean" },
    tags: boundedArraySchema({ type: "string", maxLength: 64 }, 20),
  },
  required: ["messageRefs"],
};

interface MessagesMarkBody {
  messageRefs: string[];
  read?: boolean;
  flagged?: boolean;
  junk?: boolean;
  tags?: string[];
}

export async function messagesMark(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(MESSAGES_MARK_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `message mark 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as MessagesMarkBody;
  if (parsed.read === undefined && parsed.flagged === undefined && parsed.junk === undefined && parsed.tags === undefined) {
    throw new MailAdapterError("E_VALIDATION", "message mark 至少需要指定 read/flagged/junk/tags 之一");
  }
  assertBatchLimit("mark", parsed.messageRefs.length);

  return withIdempotency("messages.mark", context, body, async () => {
    const nativeIds = parsed.messageRefs.map((ref) => resolveMessageNativeId(ref, context));
    const changes: MessageUpdateProperties = {};
    if (parsed.read !== undefined) changes.read = parsed.read;
    if (parsed.flagged !== undefined) changes.flagged = parsed.flagged;
    if (parsed.junk !== undefined) changes.junk = parsed.junk;
    if (parsed.tags !== undefined) changes.tags = parsed.tags;

    const items: Array<UndoPayload["items"][number]> = [];
    for (const nativeId of nativeIds) {
      const header = await requireHeader(nativeId);
      items.push({ messageNativeId: nativeId, priorFlags: { read: header.read, flagged: header.flagged, junk: header.junk, tags: header.tags } });
    }
    for (const nativeId of nativeIds) await browser.messages.update(nativeId, changes);

    const { operationId, undo } = issueUndoAndRecord("mark", "messages.mark", items, parsed.messageRefs, context);
    recordAudit({ routeId: "messages.mark", capability: context.capability, clientId: context.clientId, outcome: "success", affectedCount: parsed.messageRefs.length });
    return { operationId, affected: parsed.messageRefs, undo };
  });
}

// ---------------------------------------------------------------------------
// message move
// ---------------------------------------------------------------------------

const MESSAGES_MOVE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    messageRefs: boundedArraySchema(opaqueRefSchema("msg"), SCHEMA_BATCH_DOS_CAP),
    targetFolderRef: opaqueRefSchema("folder"),
  },
  required: ["messageRefs", "targetFolderRef"],
};

interface MessagesMoveBody {
  messageRefs: string[];
  targetFolderRef: string;
}

export async function messagesMove(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(MESSAGES_MOVE_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `message move 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as MessagesMoveBody;
  assertBatchLimit("move", parsed.messageRefs.length);

  return withIdempotency("messages.move", context, body, async () => {
    const { folderNativeId: targetNativeId } = resolveRef<FolderRefPayload>("folder", parsed.targetFolderRef, context);
    const targetFolder = await browser.folders.get(targetNativeId, false).catch(() => undefined);
    if (!targetFolder) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");

    const nativeIds = parsed.messageRefs.map((ref) => resolveMessageNativeId(ref, context));
    const items: Array<UndoPayload["items"][number]> = [];
    for (const nativeId of nativeIds) {
      const header = await requireHeader(nativeId);
      items.push({ messageNativeId: nativeId, priorFolderNativeId: header.folder?.id });
    }
    await browser.messages.move(nativeIds, targetFolder);

    const { operationId, undo } = issueUndoAndRecord("move", "messages.move", items, parsed.messageRefs, context);
    recordAudit({ routeId: "messages.move", capability: context.capability, clientId: context.clientId, outcome: "success", affectedCount: parsed.messageRefs.length });
    return { operationId, affected: parsed.messageRefs, undo };
  });
}

// ---------------------------------------------------------------------------
// message trash
// ---------------------------------------------------------------------------

const MESSAGES_TRASH_SCHEMA: JsonSchema = {
  type: "object",
  properties: { messageRefs: boundedArraySchema(opaqueRefSchema("msg"), SCHEMA_BATCH_DOS_CAP) },
  required: ["messageRefs"],
};

interface MessagesTrashBody {
  messageRefs: string[];
}

/** 在账号文件夹树里查找 specialUse 含 "trash" 的文件夹；深度优先，找到第一个即返回。 */
async function findTrashFolder(accountNativeId: string): Promise<MailFolder> {
  const account = await browser.accounts.get(accountNativeId, true);
  if (!account) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  const roots = account.folders ?? (account.rootFolder ? [account.rootFolder] : []);
  const stack = [...roots];
  while (stack.length > 0) {
    const folder = stack.shift()!;
    if (folder.specialUse?.includes("trash")) return folder;
    if (Array.isArray(folder.subFolders)) stack.push(...folder.subFolders);
  }
  throw new MailAdapterError("E_INTERNAL", "未找到该账号的废纸篓文件夹");
}

export async function messagesTrash(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(MESSAGES_TRASH_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `message trash 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as MessagesTrashBody;
  assertBatchLimit("trash", parsed.messageRefs.length);

  return withIdempotency("messages.trash", context, body, async () => {
    const nativeIds = parsed.messageRefs.map((ref) => resolveMessageNativeId(ref, context));
    const headers = await Promise.all(nativeIds.map((id) => requireHeader(id)));

    // 按账号分组：一次 trash 调用里的邮件可能来自不同账号，每个账号有自己的废纸篓文件夹，
    // 不能假设全部消息共享同一个目的地。
    const byAccount = new Map<string, { nativeId: number; header: MessageHeader }[]>();
    headers.forEach((header, index) => {
      const accountNativeId = header.accountId ?? header.folder?.accountId;
      if (!accountNativeId) throw new MailAdapterError("E_INTERNAL", "无法确定邮件所属账号");
      const bucket = byAccount.get(accountNativeId) ?? [];
      bucket.push({ nativeId: nativeIds[index]!, header });
      byAccount.set(accountNativeId, bucket);
    });

    const items: Array<UndoPayload["items"][number]> = [];
    for (const [accountNativeId, bucket] of byAccount) {
      const trashFolder = await findTrashFolder(accountNativeId);
      const idsInBucket = bucket.map((entry) => entry.nativeId);
      for (const entry of bucket) items.push({ messageNativeId: entry.nativeId, priorFolderNativeId: entry.header.folder?.id });
      await browser.messages.move(idsInBucket, trashFolder);
    }

    const { operationId, undo } = issueUndoAndRecord("trash", "messages.trash", items, parsed.messageRefs, context);
    recordAudit({ routeId: "messages.trash", capability: context.capability, clientId: context.clientId, outcome: "success", affectedCount: parsed.messageRefs.length });
    return { operationId, affected: parsed.messageRefs, undo };
  });
}
