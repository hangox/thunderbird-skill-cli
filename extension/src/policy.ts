// 可逆/草稿/外发域（Task #30/mail-write）共用的策略原语：批量阈值、幂等
// 去重、简单限流。这里只提供纯逻辑（不含任何 browser.* 调用），供
// mail/{mutate,drafts,send,attachments-write}.ts 复用，避免每个 handler
// 各自重新发明"这批请求算不算太大/是不是短时间内的重复提交"。
//
// 设计意图（docs/07 §批量操作、§安全默认值"不自动重试写操作"）：
// - 批量阈值是硬上限，不是建议——超过直接 E_POLICY_DENIED，不做部分执行。
// - 幂等缓存不是"防止用户手快点两次"的 UX 糖，而是防止"CLI 因超时判定失败、
//   用户据此手动重跑同一条命令"时在扩展侧产生第二次真实副作用（docs/03
//   §退出码："CLI 绝不自动重试写操作"——幂等是这条规则在扩展侧的对应防线：
//   即使调用方自己重试，只要请求体逐字节相同，也只执行一次）。
// - 限流是防御同一 client 短时间内异常高频写请求（无论是脚本错误还是恶意
//   循环）的最后一道闸，阈值刻意宽松（不应挡住正常人工/Skill 调用节奏）。
import { MailAdapterError } from "./mail/state.js";

// ---------------------------------------------------------------------------
// 批量阈值（docs/07 §批量操作表）。
// ---------------------------------------------------------------------------

export const BATCH_THRESHOLDS = {
  mark: 20,
  move: 10,
  trash: 5,
} as const;

export type BatchKind = keyof typeof BATCH_THRESHOLDS;

/** 批量数量必须在 [1, 阈值] 范围内；0 个目标（空数组）本身就是调用方的用法错误，不是"什么都不用做"的合法请求。 */
export function assertBatchLimit(kind: BatchKind, count: number): void {
  if (!Number.isInteger(count) || count < 1) {
    throw new MailAdapterError("E_VALIDATION", "messageRefs 不能为空");
  }
  const limit = BATCH_THRESHOLDS[kind];
  if (count > limit) {
    throw new MailAdapterError("E_POLICY_DENIED", `单次 ${kind} 最多处理 ${limit} 封邮件，当前请求 ${count} 封；请拆分为多次调用`);
  }
}

// ---------------------------------------------------------------------------
// 幂等去重：键 = 调用方提供的 "routeId + clientId + 规范化请求体" 摘要；
// 命中时直接返回上一次的成功结果，不重新执行任何 browser.* 副作用。
//
// 这是内存态、尽力而为的去重（不追求跨扩展重启持久），窗口刻意短
// （见 IDEMPOTENCY_TTL_MS）：只覆盖"CLI 超时后立即手动重跑"这类紧邻的重复
// 请求，不试图对"用户十分钟后确实想再做一次同样的操作"做出"这是重复"的
// 误判。
// ---------------------------------------------------------------------------

const IDEMPOTENCY_TTL_MS = 60_000;
const IDEMPOTENCY_MAX_ENTRIES = 500;

interface IdempotencyEntry {
  readonly result: unknown;
  readonly expiresAt: number;
}

class IdempotencyCache {
  private readonly entries = new Map<string, IdempotencyEntry>();

  private prune(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.entries.delete(key);
    }
  }

  get(key: string, nowMs: number = Date.now()): unknown | undefined {
    this.prune(nowMs);
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= nowMs) return undefined;
    return entry.result;
  }

  set(key: string, result: unknown, nowMs: number = Date.now()): void {
    this.prune(nowMs);
    if (this.entries.size >= IDEMPOTENCY_MAX_ENTRIES && !this.entries.has(key)) {
      // 容量已满且不是刷新已有键：淘汰最旧的一条（Map 保留插入顺序），而不是拒绝写入——
      // 幂等缓存是"尽力而为"的优化，容量压力下退化为"更短的有效去重窗口"是可接受的，
      // 不应该反过来阻塞真实的写操作。
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { result, expiresAt: nowMs + IDEMPOTENCY_TTL_MS });
  }
}

export const mailIdempotencyCache = new IdempotencyCache();

/** 规范化请求体摘要键：routeId + clientId + 按键排序后的 JSON。同一 client 对同一 route 传入逐字段相同的 body 才算命中，字段顺序不同不影响命中（业务层调用方通常已经是解析后的对象，不受 JSON 序列化顺序影响）。 */
export function idempotencyKey(routeId: string, clientId: string, body: unknown): string {
  return `${routeId}:${clientId}:${stableStringify(body)}`;
}

/** 导出供 send.ts 复用：外发确认摘要（revision/recipientDigest 等）需要同一份"字段顺序无关"的规范化序列化，避免重新实现一遍。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// 简单限流：固定窗口计数器，键通常是 clientId 本身（不区分 route，全部
// 可逆/草稿/外发写操作共享同一配额）。阈值刻意宽松，只挡异常高频（脚本
// bug/循环），不影响正常人工或 Skill 调用节奏。
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const RATE_LIMIT_MAX_TRACKED_KEYS = 1_000;

interface RateWindow {
  windowStartMs: number;
  count: number;
}

class RateLimiter {
  private readonly windows = new Map<string, RateWindow>();

  /** @throws {MailAdapterError} 超过窗口内请求上限时抛 E_POLICY_DENIED。 */
  assertWithinLimit(key: string, nowMs: number = Date.now()): void {
    if (this.windows.size >= RATE_LIMIT_MAX_TRACKED_KEYS && !this.windows.has(key)) {
      // 极端情况下的容量保护：清空全部计数窗口而不是拒绝新 client 写入——
      // 限流是防御异常高频，不应该演变成"client 太多导致新 client 完全用不了"的自我拒绝服务。
      this.windows.clear();
    }
    const window = this.windows.get(key);
    if (!window || nowMs - window.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
      this.windows.set(key, { windowStartMs: nowMs, count: 1 });
      return;
    }
    if (window.count >= RATE_LIMIT_MAX_REQUESTS) {
      throw new MailAdapterError("E_POLICY_DENIED", `写请求过于频繁：每 ${RATE_LIMIT_WINDOW_MS / 1000} 秒最多 ${RATE_LIMIT_MAX_REQUESTS} 次，请稍后重试`);
    }
    window.count += 1;
  }
}

export const mailRateLimiter = new RateLimiter();
