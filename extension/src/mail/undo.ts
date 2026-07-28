// operations.undo —— 凭 mutate.ts 签发的一次性 undo token 撤销一次可逆操作。
//
// 设计意图（team-lead/Opus 裁决，2026-07-27）：不存在/过期/已消费/跨
// client 或 pairingEpoch 一律 `E_NOT_FOUND`，不区分具体原因（与其它 ref
// 解析失败的统一语义一致，见 refs.ts 顶部设计说明，避免探测）。resolve 成功
// 后必须立即 `consume()`，防止同一 token 被兑现两次；consume 发生在真正执行
// 还原动作之前——如果还原动作本身失败（例如原文件夹已被用户手动删除），
// token 依然作废，不给调用方"重试同一个 undo"的路径，这是"写超时不得自动
// 重试"这条原则在 undo 场景下的对应处理：失败即失败，调用方需要的是新的
// 状态查询（operations get）或人工介入，而不是静默重放同一个撤销动作。
import { recordAudit } from "../audit.js";
import type { JsonSchema } from "../schema.js";
import { opaqueRefSchema, validate } from "../schema.js";
import type { UndoPayload } from "./mutate.js";
import { markOperationUndone } from "./operations.js";
import { MailAdapterError, mailRefStore, type MailAdapterContext } from "./state.js";

const OPERATIONS_UNDO_SCHEMA: JsonSchema = {
  type: "object",
  properties: { undoToken: opaqueRefSchema("undo") },
  required: ["undoToken"],
};

interface OperationsUndoBody {
  undoToken: string;
}

async function restoreMark(item: UndoPayload["items"][number]): Promise<void> {
  if (!item.priorFlags) throw new MailAdapterError("E_INTERNAL", "undo 记录缺少标记快照");
  await browser.messages.update(item.messageNativeId, item.priorFlags);
}

async function restoreFolder(item: UndoPayload["items"][number]): Promise<void> {
  if (item.priorFolderNativeId === undefined) throw new MailAdapterError("E_INTERNAL", "undo 记录缺少原文件夹快照");
  const priorFolder = await browser.folders.get(item.priorFolderNativeId, false).catch(() => undefined);
  if (!priorFolder) throw new MailAdapterError("E_NOT_FOUND", "原文件夹已不存在，无法撤销");
  await browser.messages.move([item.messageNativeId], priorFolder);
}

export async function operationsUndo(body: unknown, context: MailAdapterContext): Promise<Record<string, unknown>> {
  const result = validate(OPERATIONS_UNDO_SCHEMA, body);
  if (!result.ok) throw new MailAdapterError("E_VALIDATION", `operations undo 请求体不合法：${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  const parsed = body as OperationsUndoBody;

  const nowMs = Date.now();
  const payload = mailRefStore.resolve(parsed.undoToken, "undo", { clientId: context.clientId, pairingEpoch: context.pairingEpoch, nowMs }) as UndoPayload | undefined;
  if (!payload) {
    recordAudit({ routeId: "operations.undo", capability: context.capability, clientId: context.clientId, outcome: "denied" });
    throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  }
  // 一次性消费：无论后续还原是否全部成功，这个 token 都不再可用。
  mailRefStore.consume(parsed.undoToken);

  for (const item of payload.items) {
    if (payload.kind === "mark") await restoreMark(item);
    else await restoreFolder(item);
  }

  markOperationUndone(payload.operationId);
  recordAudit({ routeId: "operations.undo", capability: context.capability, clientId: context.clientId, outcome: "success", restoredCount: payload.items.length });
  return { undone: true, operationId: payload.operationId, restored: payload.items.length };
}
