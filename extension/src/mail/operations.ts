// operations.get —— 查询可逆/外发操作的当前状态；也是 mutate.ts/undo.ts/
// send.ts 共用的 operation 记录表（Task #30/mail-write 内部共享，全部三个
// 文件都是我独占范围，因此把这张表放在 operations.ts 一处而不是各自维护，
// 避免"同一个 operationId 在多处有不同真值"）。
//
// 设计意图：`mailRefStore` 的 "op" ref kind 只负责"这个 operationId 是否
// 存在、是否属于当前 client+pairingEpoch、是否已过期"这三件事（见
// extension/src/refs.ts 顶部设计说明：解析失败一律 E_NOT_FOUND，不泄漏
// 存在性）——但 RefStore 的 payload 一旦签发就不可变（没有"原地更新"的
// API），而 operation 的状态会随 undo 变化（completed → undone）。因此这里
// 用一张独立的、以 operationId 为键的普通 Map 存放"会变化的那部分"，op ref
// 本身只当作"这个 operationId 有效且属于你"的授权凭据，状态永远从这张 Map
// 里读——两者的过期节奏不需要严格一致：Map 记录允许比 op ref 活得更久（查询
// 时以 ref 是否仍能 resolve 为准，ref 过期后即使 Map 里还有记录也一律
// E_NOT_FOUND），但不允许更短（否则会出现"ref 还有效但记录已经没了"的
// 内部不一致，那种情况在 getOperationRecord 里当成 E_INTERNAL 处理，因为
// 那是本模块自身的 bug，不是调用方的错）。
import type { JsonSchema } from "../schema.js";
import { opaqueRefSchema, validate } from "../schema.js";
import { MailAdapterError, issueRef, resolveRef, type MailAdapterContext } from "./state.js";

export type OperationKind = "messages.mark" | "messages.move" | "messages.trash" | "drafts.send";
export type OperationState = "completed" | "undone" | "sent" | "failed";

export interface OperationRecord {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly affected: readonly string[];
  readonly clientId: string;
  readonly pairingEpoch: string;
  state: OperationState;
  readonly createdAtMs: number;
  /** 存在即表示"仍可撤销"；undo.ts 兑现后调用 clearUndoToken 置空，且与 op ref 的存在性无关（op ref 过期不代表 undo token 也已过期，两者独立签发、独立 TTL）。 */
  undoToken?: string;
}

/** 单条记录的最长在途时间：与 op ref 的 TTL（`REF_TTL_MS.op` = `MAX_REF_TTL_MS`，30 分钟）保持同一上限，避免这张 Map 无界增长。 */
const OPERATION_RECORD_TTL_MS = 30 * 60 * 1000;
const MAX_OPERATION_RECORDS = 4_000;

const operationRecords = new Map<string, OperationRecord>();

function pruneExpired(nowMs: number): void {
  for (const [id, record] of operationRecords) {
    if (nowMs - record.createdAtMs > OPERATION_RECORD_TTL_MS) operationRecords.delete(id);
  }
}

/**
 * mutate.ts/send.ts 在完成一次可逆/外发写操作后调用：先用 `issueRef("op", context, {})` 拿到
 * operationId（payload 留空——鉴权与过期完全交给 ref，本函数只登记"会变化的那部分"），
 * 再传给这里登记初始状态。
 */
export function recordOperation(operationId: string, kind: OperationKind, affected: readonly string[], context: MailAdapterContext, state: OperationState, undoToken?: string): void {
  const nowMs = Date.now();
  pruneExpired(nowMs);
  if (operationRecords.size >= MAX_OPERATION_RECORDS && !operationRecords.has(operationId)) {
    throw new MailAdapterError("E_INTERNAL", "operation 记录表已达到上限，请稍后重试");
  }
  const record: OperationRecord = {
    operationId, kind, affected, clientId: context.clientId, pairingEpoch: context.pairingEpoch, state, createdAtMs: nowMs,
    ...(undoToken ? { undoToken } : {}),
  };
  operationRecords.set(operationId, record);
}

/** undo.ts 兑现成功后调用：把记录状态改成 "undone" 并清空 undoToken（防止同一条记录被误认为仍可撤销）。 */
export function markOperationUndone(operationId: string): void {
  const record = operationRecords.get(operationId);
  if (!record) return; // 记录已过期被清理：undo.ts 自己已经在 undoToken 层面完成了鉴权与一次性消费，这里找不到只是记账数据先行过期，不是错误。
  record.state = "undone";
  delete record.undoToken;
}

/** 供 mutate.ts/undo.ts/send.ts 校验/展示用：按 operationId 精确读取（不做 client/epoch 校验——调用方必须先经过 op ref 的 resolveRef 完成鉴权，这里只是数据查找）。 */
export function peekOperationRecord(operationId: string): OperationRecord | undefined {
  return operationRecords.get(operationId);
}

// ---------------------------------------------------------------------------
// operations.get handler
// ---------------------------------------------------------------------------

const OPERATIONS_GET_SCHEMA: JsonSchema = {
  type: "object",
  properties: { operationId: opaqueRefSchema("op") },
  required: ["operationId"],
};

interface OperationsGetBody {
  operationId: string;
}

export async function operationsGet(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(OPERATIONS_GET_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `operations get 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as OperationsGetBody;

  // resolveRef 完成鉴权（存在/未过期/属于当前 client+pairingEpoch），统一映射 E_NOT_FOUND；
  // payload 本身是空对象（见 recordOperation 的调用方式），这里只用它的"能否 resolve"结果。
  resolveRef<Record<string, never>>("op", parsed.operationId, context);

  const record = operationRecords.get(parsed.operationId);
  if (!record) {
    // op ref 仍有效但记录表里已经没有：说明记录先于 ref 过期，属于本模块内部 TTL 配置
    // 不一致的 bug（见文件头设计说明），不应该发生；失败关闭为 E_INTERNAL 而不是假装成功。
    throw new MailAdapterError("E_INTERNAL", "operation 记录与授权状态不一致");
  }

  return {
    operationId: record.operationId,
    kind: record.kind,
    state: record.state,
    affected: record.affected,
    undoable: record.undoToken !== undefined,
    createdAt: new Date(record.createdAtMs).toISOString(),
  };
}
