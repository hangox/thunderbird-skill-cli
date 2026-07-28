// stdout/stderr envelope 输出与退出码映射。
//
// 设计意图：JSON 模式 stdout 永远恰好一个 UTF-8 JSON 文档 + 换行，退出码是
// 错误码到"自动化下一步动作"的稳定映射（docs/03 §退出码）。这里不含任何
// 命令特定逻辑，是纯粹的"结果 -> 输出"转换层，供 cli.ts 的全部命令
// （现有 status/doctor/setup/xpi 与新挂载的邮件命令）共用。
import { COMMANDS } from "./contracts/commands.js";
import { CLI_SCHEMA_VERSION, createRequestId, type ErrorCode, type ErrorEnvelope, type MailErrorDetails, type SuccessEnvelope } from "./contracts/envelope.js";

export const EXIT = { OK: 0, USAGE: 2, NOT_READY: 3, AUTH: 4, POLICY: 5, NOT_FOUND: 6, TEMPORARY: 7, INTERNAL: 10 } as const;

export function exitFor(code: ErrorCode): number {
  if (code === "E_USAGE" || code === "E_VALIDATION") return EXIT.USAGE;
  if (["E_NOT_IMPLEMENTED", "E_NOT_PAIRED", "E_THUNDERBIRD_OFFLINE", "E_AMBIGUOUS_INSTANCE", "E_PAIRING_PENDING", "E_ALREADY_PAIRED"].includes(code)) return EXIT.NOT_READY;
  if (code === "E_AUTH" || code === "E_REPLAY" || code === "E_VERSION_MISMATCH") return EXIT.AUTH;
  if (code === "E_CONFIRMATION_REQUIRED" || code === "E_POLICY_DENIED") return EXIT.POLICY;
  if (code === "E_NOT_FOUND") return EXIT.NOT_FOUND;
  if (code === "E_TIMEOUT" || code === "E_PAIRING_CHANGED") return EXIT.TEMPORARY;
  return EXIT.INTERNAL;
}

export function emitError(command: string, code: ErrorCode, message: string, retryable: boolean, human: boolean, details?: MailErrorDetails): never {
  if (human) process.stderr.write(`${message}\n`);
  else {
    const payload: ErrorEnvelope = { schemaVersion: CLI_SCHEMA_VERSION, ok: false, command, requestId: createRequestId(), error: { code, message, retryable, ...(details ? { details } : {}) } };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  process.exit(exitFor(code));
}

export function emitSuccess<T>(command: string, data: T, human: boolean, startedAt: number, warnings: string[] = []): never {
  if (human) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else {
    const payload: SuccessEnvelope<T> = { schemaVersion: CLI_SCHEMA_VERSION, ok: true, command, requestId: createRequestId(), data, meta: { durationMs: Date.now() - startedAt, truncated: false, warnings } };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  process.exit(EXIT.OK);
}

export function printHelp(): void {
  process.stdout.write([
    "thunderbird — Thunderbird Skill CLI", "",
    "用法：thunderbird [--json|--human] [--instance ID|--profile ID] [--client ID] [--timeout MS] <command> [args]", "",
    ...COMMANDS.map((command) => `  ${command.path.join(" ").padEnd(24)} ${command.summary} [${command.phase}/${command.risk}]`), "",
    "诊断/配对/安装辅助（doctor/status/setup/xpi）与全部只读/可逆/草稿-外发邮件命令的 CLI 外壳与传输管线均已实现。",
    "message delete、calendar、watch 三项本轮明确不纳入：不接受任何参数，恒定返回 E_NOT_IMPLEMENTED。",
    "邮件命令的实际数据访问依赖 Thunderbird 扩展侧邮件适配层；适配层未接线前，已挂载命令会返回 E_NOT_IMPLEMENTED。",
  ].join("\n") + "\n");
}
