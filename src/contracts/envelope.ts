export const CLI_SCHEMA_VERSION = "1.0" as const;

export type ErrorCode =
  | "E_USAGE"
  | "E_NOT_IMPLEMENTED"
  | "E_NOT_PAIRED"
  | "E_THUNDERBIRD_OFFLINE"
  | "E_AMBIGUOUS_INSTANCE"
  | "E_AUTH"
  | "E_REPLAY"
  | "E_PAIRING_PENDING"
  | "E_ALREADY_PAIRED"
  | "E_PAIRING_CHANGED"
  | "E_VERSION_MISMATCH"
  | "E_VALIDATION"
  | "E_CONFIRMATION_REQUIRED"
  | "E_POLICY_DENIED"
  | "E_NOT_FOUND"
  | "E_TIMEOUT"
  | "E_INTERNAL";

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
    details?: Record<string, unknown>;
  };
}

export type CliEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function createRequestId(): string {
  return `cli_${crypto.randomUUID()}`;
}
