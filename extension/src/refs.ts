// Opaque ref / cursor / undo / confirm / operation 令牌的共享原语。
//
// 设计意图：CLI 是一次性进程，扩展实例在 Thunderbird 会话内长期存活；因此
// 令牌不需要做成自描述签名（如 JWT），只需在扩展内存中维护一张短期、可裁剪
// 的绑定表——键是高熵随机 token（构造上不可猜测/不可伪造），值是
// {kind, clientId, pairingEpoch, payload, 过期时间}。resolve 时要求当前请求的
// clientId 与 pairingEpoch 与签发时完全一致，任何一项不符都视为不存在
// （调用方必须统一映射为 E_NOT_FOUND，不得泄漏“对象存在但不属于你”）。
//
// 这与仓库里 pairing intent（intent_...)、descriptor 等既有令牌的实现风格一致，
// 只是把它抽成一个可复用、可单测的通用类，供 message/folder/draft/undo/
// confirm/operation/cursor 等所有需要 opaque ref 的能力共用，而不是每个能力
// 各自重新发明一套绑定与过期逻辑。
//
// extension/bridge/api.js 中维护一份运行在 Experiment 特权作用域下的等价实现
// （用 webCrypto.getRandomValues 代替 Node crypto），两者靠测试保持同步。
//
// 范围裁决（team-lead，2026-07-27）：v0.3.0 不实现永久删除，因此不含破坏性
// 操作 prepare 阶段专用的 "preview" ref kind 与 UI 人工确认回执登记表；
// "confirm" kind 仍保留给 draft send 的 prepare/confirm 两阶段外发确认用。

export type RefKind =
  | "acc" // account
  | "folder"
  | "msg"
  | "draft"
  | "identity"
  | "attachment"
  | "op" // operation id
  | "undo"
  | "confirm" // draft send 的 prepare/confirm 外发确认 id
  | "cursor";

export const REF_KINDS: readonly RefKind[] = ["acc", "folder", "msg", "draft", "identity", "attachment", "op", "undo", "confirm", "cursor"] as const;

export function refPattern(kind: RefKind): RegExp {
  return new RegExp(`^${kind}_[A-Za-z0-9_-]{16,128}$`);
}

export interface RandomTokenSource {
  /** 返回 length 字节的密码学安全随机数据的十六进制字符串。 */
  randomHex(length: number): string;
  nowMs(): number;
}

export interface RefEntry<T> {
  readonly kind: RefKind;
  readonly clientId: string;
  readonly pairingEpoch: string;
  readonly payload: T;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ResolveContext {
  readonly clientId: string;
  readonly pairingEpoch: string;
  readonly nowMs: number;
}

/** 单个 kind 允许持有的最大在途条目数；超过时先做一次过期清理，仍超限则拒绝签发新 ref，绝不静默驱逐仍有效的条目。 */
const DEFAULT_MAX_ENTRIES_PER_KIND = 4_000;

/** 跨全部 kind 合计的在途条目上限，独立于单 kind 上限，防止很多个 kind 各自不超限但合计仍占用过多内存（压力回收的第二道防线）。 */
const DEFAULT_MAX_TOTAL_ENTRIES = 20_000;

/** 单个 ref 允许的最长存活时间；即使调用方传入更大的 ttlMs 也会被拒绝，而不是静默接受一个长期存活、扩大暴露窗口的 ref。 */
export const MAX_REF_TTL_MS = 30 * 60 * 1000;

/** issue() 因配额耗尽而拒绝时抛出的显式类型错误，调用方可据此与"其他内部错误"区分并映射为稳定的 CLI 错误语义（而不是笼统的 500）。`kind: "*"` 表示命中的是跨 kind 的全局上限，而不是某个具体 kind 的上限。 */
export class RefStoreCapacityError extends Error {
  constructor(
    readonly kind: RefKind | "*",
    readonly limit: number,
  ) {
    super(kind === "*" ? `ref store 已达到全局在途上限（${limit}），拒绝签发新 ref` : `ref kind ${kind} 已达到在途上限（${limit}），拒绝签发新 ref`);
    this.name = "RefStoreCapacityError";
  }
}

export class RefStore<T = unknown> {
  private readonly entries = new Map<string, RefEntry<T>>();
  private readonly countByKind = new Map<RefKind, number>();

  constructor(
    private readonly source: RandomTokenSource,
    private readonly maxEntriesPerKind: number = DEFAULT_MAX_ENTRIES_PER_KIND,
    private readonly maxTotalEntries: number = DEFAULT_MAX_TOTAL_ENTRIES,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * 过期回收：调用方（api.js）应在每个已认证请求上都调用一次（与既有的
   * nonce 清理同一节奏），而不是只在 issue() 内部懒清理——这样即使某个 kind
   * 长时间没有新的 issue() 调用，过期条目也会随请求流量被及时释放，内存不会
   * 无限期停留到下一次该 kind 被用到为止。
   */
  prune(nowMs: number = this.source.nowMs()): void {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.remove(token);
    }
  }

  /** @throws {RangeError} ttlMs 不是正有限数，或超过 MAX_REF_TTL_MS。 */
  /** @throws {RefStoreCapacityError} 该 kind 或全局在途配额已耗尽（已先做过一次过期回收）。 */
  issue(kind: RefKind, clientId: string, pairingEpoch: string, payload: T, ttlMs: number): string {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs 必须是正有限数");
    if (ttlMs > MAX_REF_TTL_MS) throw new RangeError(`ttlMs 不得超过 MAX_REF_TTL_MS（${MAX_REF_TTL_MS}ms）`);
    this.prune();
    if (this.entries.size >= this.maxTotalEntries) {
      throw new RefStoreCapacityError("*", this.maxTotalEntries);
    }
    const current = this.countByKind.get(kind) ?? 0;
    if (current >= this.maxEntriesPerKind) {
      throw new RefStoreCapacityError(kind, this.maxEntriesPerKind);
    }
    const nowMs = this.source.nowMs();
    let token: string;
    do {
      token = `${kind}_${this.source.randomHex(24)}`;
    } while (this.entries.has(token));
    this.entries.set(token, { kind, clientId, pairingEpoch, payload, issuedAt: nowMs, expiresAt: nowMs + ttlMs });
    this.countByKind.set(kind, current + 1);
    return token;
  }

  /** 解析失败（不存在/kind 不符/client 不符/epoch 不符/已过期）一律返回 undefined，不区分具体原因，避免枚举探测。 */
  resolve(token: string, expectedKind: RefKind, context: ResolveContext): T | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.kind !== expectedKind) return undefined;
    if (entry.clientId !== context.clientId) return undefined;
    if (entry.pairingEpoch !== context.pairingEpoch) return undefined;
    if (entry.expiresAt <= context.nowMs) { this.remove(token); return undefined; }
    return entry.payload;
  }

  /** confirm/undo 类一次性令牌：resolve 成功后必须调用，防止重放使用。 */
  consume(token: string): void {
    this.remove(token);
  }

  revokeAllForClient(clientId: string): void {
    for (const [token, entry] of this.entries) {
      if (entry.clientId === clientId) this.remove(token);
    }
  }

  clear(): void {
    this.entries.clear();
    this.countByKind.clear();
  }

  private remove(token: string): void {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    const current = this.countByKind.get(entry.kind) ?? 0;
    if (current > 0) this.countByKind.set(entry.kind, current - 1);
  }
}
