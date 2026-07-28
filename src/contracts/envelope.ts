export const CLI_SCHEMA_VERSION = "1.0" as const;

export const ERROR_CODES = [
  "E_USAGE",
  "E_NOT_IMPLEMENTED",
  "E_NOT_PAIRED",
  "E_THUNDERBIRD_OFFLINE",
  "E_AMBIGUOUS_INSTANCE",
  "E_AUTH",
  "E_REPLAY",
  "E_PAIRING_PENDING",
  "E_ALREADY_PAIRED",
  "E_PAIRING_CHANGED",
  "E_VERSION_MISMATCH",
  "E_VALIDATION",
  "E_CONFIRMATION_REQUIRED",
  "E_POLICY_DENIED",
  "E_NOT_FOUND",
  "E_TIMEOUT",
  "E_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Task #43：邮件 route 失败响应可携带的结构化补充信息——刻意收窄到一个具名
// 字段而不是任意 `Record<string, unknown>`，因为 details 最终会被 CLI 原样
// 输出到 stdout（JSON envelope）：一个宽松的 details 类型等于给"扩展侧
// 不小心把整个 body/context 对象挂到 details 上"开了一条能绕过 review 的
// 隐式泄漏通道。目前唯一的合法字段是 operationId（例如 drafts.send.confirm
// 失败时告知调用方去哪查 operation 状态），值必须是合法 opaque ref。
// src/transport.ts 的 parseMailRouteErrorBody 与
// extension/src/background.ts 的 extractErrorDetails 是这份契约的两份
// 独立校验实现（后者跨 tsconfig rootDir，只能手工镜像），新增字段必须三处
// 同步修改。
export interface MailErrorDetails {
  readonly operationId?: string;
}

export interface SuccessEnvelope<T> {
  schemaVersion: typeof CLI_SCHEMA_VERSION;
  ok: true;
  command: string;
  requestId: string;
  data: T;
  meta: {
    durationMs: number;
    truncated: boolean;
    warnings: string[];
    nextCursor?: string;
  };
}

export interface ErrorEnvelope {
  schemaVersion: typeof CLI_SCHEMA_VERSION;
  ok: false;
  command: string;
  requestId: string;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    details?: MailErrorDetails;
  };
}

export type CliEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function createRequestId(): string {
  return `cli_${crypto.randomUUID()}`;
}
