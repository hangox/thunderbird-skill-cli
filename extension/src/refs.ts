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

export class RefStore<T = unknown> {
  private readonly entries = new Map<string, RefEntry<T>>();
  private readonly countByKind = new Map<RefKind, number>();

  constructor(
    private readonly source: RandomTokenSource,
    private readonly maxEntriesPerKind: number = DEFAULT_MAX_ENTRIES_PER_KIND,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  prune(nowMs: number = this.source.nowMs()): void {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.remove(token);
    }
  }

  issue(kind: RefKind, clientId: string, pairingEpoch: string, payload: T, ttlMs: number): string {
    this.prune();
    const current = this.countByKind.get(kind) ?? 0;
    if (current >= this.maxEntriesPerKind) {
      throw new Error(`ref kind ${kind} 已达到在途上限，拒绝签发新 ref`);
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
