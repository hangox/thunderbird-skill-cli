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
// 用于跨会话关联同一用户的行为模式）。真正的 keyed hash（而不是可公开重算
// 的裸摘要）——见下方 AUDIT_HASH_KEY/hashClientId：外部即便知道明文
// clientId，缺少这个进程私有随机 key 也无法重算出同样的 `client#...` 值，
// 因此不能靠"猜测 clientId 再比对日志"的方式反查身份。
//
// 结构化 allowlist（Task #42 收敛，2026-07-27）：此前 `detail` 是自由文本
// `string`，脱敏完全依赖调用方自律——TypeScript 类型系统挡不住任何人在
// 某次改动里手滑传入 `detail: subject` 或 `detail: JSON.stringify(body)`。
// 现在把"能记录什么"收窄成一张固定 allowlist：一个封闭的 reason 枚举 +
// 若干个数字/布尔字段，`recordAudit` 内部逐字段手工拷贝并做运行时类型
// 校验，不接受也不透传 allowlist 之外的任何属性——即使调用方是绕过
// TypeScript 的普通 JS（或者未来某次改动手滑在调用处多塞了一个字段），
// 运行时也不会把它序列化进日志，这是比"类型层禁止"更强的保证。
export type AuditOutcome = "success" | "denied" | "error";

/**
 * 封闭的 reason 枚举：只允许这些固定字符串，不接受任何调用方自定义文本。
 * 新增一种"原因"必须在这里显式加一个新枚举值，而不是随手传一个新字符串。
 */
export type AuditReason =
  | "too-large"
  | "too-large-actual"
  | "reused-tab"
  | "reopened-from-template"
  | "confirm-not-found"
  | "revision-mismatch"
  | "tab-closed"
  | "live-digest-mismatch"
  | "send-failed"
  | "send-permission-missing";

const AUDIT_REASONS: ReadonlySet<string> = new Set<AuditReason>([
  "too-large", "too-large-actual", "reused-tab", "reopened-from-template",
  "confirm-not-found", "revision-mismatch", "tab-closed", "live-digest-mismatch", "send-failed",
  "send-permission-missing",
]);

export interface AuditEvent {
  readonly routeId: string;
  readonly capability: string;
  readonly clientId: string;
  readonly outcome: AuditOutcome;
  /** 封闭枚举，不是自由文本。 */
  readonly reason?: AuditReason;
  readonly affectedCount?: number;
  readonly restoredCount?: number;
  readonly sizeBytes?: number;
  readonly offsetBytes?: number;
  readonly done?: boolean;
}

// 进程私有随机 key：模块加载（背景脚本启动）时生成一次，此后常驻内存、
// 从不写入任何日志/返回值，也没有任何导出路径可以读到它。128 bit（4 个
// 32-bit word）——同一进程内所有 hashClientId() 调用共享这同一份 key，
// 因此同进程内同一个 clientId 的 hash 保持稳定（可以在日志里关联同一
// client 的多条事件）；扩展重启（进程重启）后模块重新加载会生成一份新
// key，之前进程产出的日志与新进程的 hash 不再相同——这不是 bug，是"外部
// 不能靠长期收集同一 clientId 的历史 hash 值来跨重启建立稳定画像"这条
// 设计意图的直接体现。
const AUDIT_HASH_KEY = new Uint32Array(4);
crypto.getRandomValues(AUDIT_HASH_KEY);

/** 把一个 32-bit word 的全部 4 个字节依次混入 FNV-1a 累加器（而不是把 word 当成单个数字异或一次，那样只有低 8 位真正参与逐字节混合）。 */
function mixWord(hash: number, word: number): number {
  hash ^= word & 0xff; hash = Math.imul(hash, 0x01000193);
  hash ^= (word >>> 8) & 0xff; hash = Math.imul(hash, 0x01000193);
  hash ^= (word >>> 16) & 0xff; hash = Math.imul(hash, 0x01000193);
  hash ^= (word >>> 24) & 0xff; hash = Math.imul(hash, 0x01000193);
  return hash;
}

/**
 * 真正的 keyed hash（不是可公开重算的裸 FNV-1a）：两个并行的 32-bit
 * FNV-1a 累加器，各自先用两个不同的 AUDIT_HASH_KEY word 初始化（因此两个
 * 累加器从一开始就依赖进程私有的随机 key，不只是在最后异或一下 key），
 * 再把 clientId 的 UTF-16 code unit 逐个混入两个累加器，最后拼接成 64 bit
 * （16 位十六进制）输出。不需要抗碰撞的密码学强度（clientId 不是需要防
 * 伪造的秘密），只需要"没有 key 就无法重算、同进程同输入稳定、不同输入
 * 大概率不同"。
 */
function hashClientId(clientId: string): string {
  let h1 = mixWord(mixWord(0x811c9dc5, AUDIT_HASH_KEY[0]!), AUDIT_HASH_KEY[1]!);
  let h2 = mixWord(mixWord(0x811c9dc5, AUDIT_HASH_KEY[2]!), AUDIT_HASH_KEY[3]!);
  for (let index = 0; index < clientId.length; index += 1) {
    const code = clientId.charCodeAt(index);
    h1 ^= code; h1 = Math.imul(h1, 0x01000193);
    h2 ^= code; h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** 非负安全整数：拒绝 NaN/Infinity/负数/非整数，这类畸形值直接丢弃该字段而不是让它以奇怪形式进日志。 */
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 记录一条脱敏审计事件；每个 mutate/drafts/send/attachments-write/undo/
 * operations handler 在成功、策略拒绝、内部错误三类结果上各调用一次。
 *
 * 手工逐字段拷贝、运行时校验类型——即使 `event` 在运行时实际携带了
 * allowlist 之外的任意属性（例如某处调用被篡改/手滑传入了 `subject`/
 * `path`/`token`/`nonce`），这里也绝不会把它们读出来、更不会写进日志：
 * 这不是"忘了脱敏"，而是这个函数的实现根本不存在读取任意属性的代码路径。
 */
export function recordAudit(event: AuditEvent): void {
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    route: typeof event.routeId === "string" ? event.routeId : "",
    capability: typeof event.capability === "string" ? event.capability : "",
    client: `client#${hashClientId(typeof event.clientId === "string" ? event.clientId : "")}`,
    outcome: event.outcome === "success" || event.outcome === "denied" || event.outcome === "error" ? event.outcome : "error",
  };
  if (typeof event.reason === "string" && AUDIT_REASONS.has(event.reason)) line.reason = event.reason;
  if (isNonNegativeSafeInteger(event.affectedCount)) line.affectedCount = event.affectedCount;
  if (isNonNegativeSafeInteger(event.restoredCount)) line.restoredCount = event.restoredCount;
  if (isNonNegativeSafeInteger(event.sizeBytes)) line.sizeBytes = event.sizeBytes;
  if (isNonNegativeSafeInteger(event.offsetBytes)) line.offsetBytes = event.offsetBytes;
  if (typeof event.done === "boolean") line.done = event.done;

  if (line.outcome === "error") console.error("[thunderbird-skill-bridge][audit]", JSON.stringify(line));
  else console.info("[thunderbird-skill-bridge][audit]", JSON.stringify(line));
}
