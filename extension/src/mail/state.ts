// 全部邮件 adapter（只读域 + 后续可逆/草稿域）共用的 opaque ref/cursor 单例，
// 以及 handler 通用的错误类型与请求上下文形状。
//
// 设计意图：`extension/src/refs.ts` 只导出 `RefStore` 类本身，不含任何实例——
// 这是刻意的（供纯逻辑单测），但真实运行时只能有一份 in-memory 绑定表：本域
// （accounts/folders/search/message get&open/attachments list）签发的
// msg_/folder_/acc_ ref，必须能被可逆域（message mark/move/trash/undo）与
// 草稿域解析，两边各自 `new RefStore()` 会导致互相看不到对方签发的 ref。
// 因此这份单例被放进一个不属于任何单一能力域的独立文件，供所有 mail/*.ts
// adapter 共同 import，只新增文件、不修改任何人已占的文件。
//
import { MAX_REF_TTL_MS, RefStore, type RandomTokenSource, type RefKind } from "../refs.js";

// TTL 约定：`RefStore.issue()` 硬性拒绝任何超过 `MAX_REF_TTL_MS`（30 分钟，见
// refs.ts）的 ttlMs，因此这里全部 ref kind 的 TTL 都以它为上限——账号/文件夹/
// 身份 ref 用满这个上限（在扩展进程生命周期内足够稳定，也不需要比这更长）；
// 消息/附件 ref 与 Thunderbird 原生 `id` 的生命周期语义一致（重启/移动后原生
// id 本身就会失效，见 docs/01 附录 A.4②），给更短的 TTL；cursor 是分页续取用
// 的短期状态，给最短的 TTL。
export const REF_TTL_MS = {
  acc: MAX_REF_TTL_MS,
  identity: MAX_REF_TTL_MS,
  folder: MAX_REF_TTL_MS,
  msg: 15 * 60 * 1000,
  attachment: 15 * 60 * 1000,
  cursor: 5 * 60 * 1000,
} as const;

const tokenSource: RandomTokenSource = {
  randomHex(length: number): string {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  },
  nowMs(): number {
    return Date.now();
  },
};

/** 全部邮件能力域共用的单一 RefStore 实例；只读域负责创建（本文件），其余域直接 import 使用，不得各自再 `new`。 */
export const mailRefStore = new RefStore<unknown>(tokenSource);

/**
 * handler 收到的请求上下文。`clientId`/`pairingEpoch` 取自 api.js 已验证的
 * securityRequest，经 onOperation 事件、`background.ts` 的 `handleOperation`
 * 逐层透传到这里——两者都是必填字段（不是当初的可选降级字段）：ref 的
 * client/pairingEpoch 精确绑定（见 refs.ts 顶部设计说明：resolve 要求两者
 * 与签发时完全一致）现在端到端真实生效，不存在"未区分 client"的降级桶。
 */
export interface MailAdapterContext {
  readonly capability: string;
  readonly clientId: string;
  readonly pairingEpoch: string;
}

function resolveContext(context: MailAdapterContext): { clientId: string; pairingEpoch: string; nowMs: number } {
  return { clientId: context.clientId, pairingEpoch: context.pairingEpoch, nowMs: Date.now() };
}

/**
 * handler 侧统一的业务错误：携带 `src/contracts/envelope.ts` 里冻结的
 * `ErrorCode` 子集。`background.ts` 的 `handleOperation` 会优先读取
 * `error.code`（duck-typing，不要求 `instanceof MailAdapterError`）透传给
 * CLI，而不是无条件折叠成 `E_INTERNAL`。
 */
export class MailAdapterError extends Error {
  constructor(
    readonly code: "E_VALIDATION" | "E_NOT_FOUND" | "E_POLICY_DENIED" | "E_INTERNAL",
    message: string,
  ) {
    super(message);
    this.name = "MailAdapterError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// ref 签发/解析的薄封装：统一走 `resolveContext`（clientId/pairingEpoch 降级
// 处理）与固定 TTL 表，业务 handler 不直接碰 `mailRefStore.issue/resolve`。
// ---------------------------------------------------------------------------

export function issueRef(kind: RefKind, context: MailAdapterContext, payload: unknown): string {
  const { clientId, pairingEpoch } = resolveContext(context);
  return mailRefStore.issue(kind, clientId, pairingEpoch, payload, REF_TTL_MS[kind as keyof typeof REF_TTL_MS] ?? REF_TTL_MS.msg);
}

/** 解析失败统一抛 E_NOT_FOUND：不区分"格式错/不存在/跨 client/已过期"，避免探测（见 refs.ts 顶部设计说明）。 */
export function resolveRef<T = unknown>(kind: RefKind, token: string, context: MailAdapterContext): T {
  const { clientId, pairingEpoch, nowMs } = resolveContext(context);
  const payload = mailRefStore.resolve(token, kind, { clientId, pairingEpoch, nowMs });
  if (payload === undefined) throw new MailAdapterError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  return payload as T;
}
