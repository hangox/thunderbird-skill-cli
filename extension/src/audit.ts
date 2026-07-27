// 可逆/草稿/外发域（Task #30/mail-write）的脱敏审计日志。
//
// 设计意图（docs/07 §本机日志策略、§敏感信息与脱敏表）：默认 INFO 只记录
// 脱敏审计——route/结果/client 的 keyed hash，永不记录 token/nonce/正文/
// 完整地址/完整主题/本机路径。background.ts 运行在普通 WebExtension 背景页
// 作用域，没有特权文件系统写入能力（那是 Experiment 侧 api.js 的职责，见
// extension/src/background.ts 顶部注释），因此这里只做"结构化 console 输出"
// 这一层——真正落盘到 `docs/07` 描述的 0600 日志文件、按大小轮转等，属于
// 需要 Experiment 特权的能力，不在本文件范围内（若未来需要，应在 api.js/
// schema.json 新增一个"提交审计事件"的桥接口，那是平台层的改动）。
//
// clientId 本身不是凭据（不是 token/nonce），但仍按 docs/07 的"keyed hash"
// 原则处理，避免原始 clientId 大量出现在日志里（例如被日志聚合工具索引后
// 用于跨会话关联同一用户的行为模式）。
export type AuditOutcome = "success" | "denied" | "error";

export interface AuditEvent {
  readonly routeId: string;
  readonly capability: string;
  readonly clientId: string;
  readonly outcome: AuditOutcome;
  /** 极简、非敏感的补充信息（例如 "affected=3"、错误码），不得包含正文/主题/地址/路径。 */
  readonly detail?: string;
}

/** 非密码学用途的 keyed hash：只需要"不可逆展示原文、同一输入稳定映射到同一摘要"，不需要抗碰撞强度（clientId 不是需要防伪造的秘密）。 */
function hashClientId(clientId: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let index = 0; index < clientId.length; index += 1) {
    hash ^= clientId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 记录一条脱敏审计事件；每个 mutate/drafts/send/attachments-write/undo/operations handler 在成功、策略拒绝、内部错误三类结果上各调用一次。 */
export function recordAudit(event: AuditEvent): void {
  const line = {
    ts: new Date().toISOString(),
    route: event.routeId,
    capability: event.capability,
    client: `client#${hashClientId(event.clientId)}`,
    outcome: event.outcome,
    ...(event.detail ? { detail: event.detail } : {}),
  };
  if (event.outcome === "error") console.error("[thunderbird-skill-bridge][audit]", JSON.stringify(line));
  else console.info("[thunderbird-skill-bridge][audit]", JSON.stringify(line));
}
