// 邮件命令输入体读取：`--input FILE|-`（以及 draft send 的 `--confirm FILE|-`）
// 的统一实现。
//
// 设计意图：docs/03 的核心安全约定之一是"敏感或多行内容永远经文件或 stdin，
// 不内联到 argv"——FORBIDDEN_FLAGS 已经在 args.ts 拒绝 --body/--html，这里
// 补上另一半：文件/stdin 读取本身的边界（只接受绝对路径或 "-"、硬性大小上限、
// 必须是合法 JSON 对象、拒绝 __proto__/prototype/constructor 原型污染键）。
// 这是 CLI 侧的第一道防线，扩展侧会按各 route 的业务 schema 再做一次权威校验，
// 两者刻意都做、互不替代。
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { DiscoveryError } from "./discovery.js";

/** 与 docs/02 架构文档中"JSON 路由 1 MiB"的口径一致；具体 route 的硬上限由 extension 侧按 contracts/routes.ts 强制执行，这里只是客户端侧的早失败保护。 */
export const MAX_INPUT_BYTES = 1 * 1024 * 1024;

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeJsonValue(value: unknown, flagName: string): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJsonValue(item, flagName);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) throw new DiscoveryError("E_VALIDATION", `${flagName} 内容包含禁止的键名 ${key}`);
    assertSafeJsonValue((value as Record<string, unknown>)[key], flagName);
  }
}

async function readStdin(flagName: string): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_INPUT_BYTES) throw new DiscoveryError("E_VALIDATION", `${flagName} 的 stdin 输入超过大小上限`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readInputFile(path: string, flagName: string): Promise<string> {
  if (!isAbsolute(path)) throw new DiscoveryError("E_VALIDATION", `${flagName} 只接受绝对路径或 -`);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new DiscoveryError("E_VALIDATION", `${flagName} 指向的文件不存在或不可读`);
  }
  if (!info.isFile()) throw new DiscoveryError("E_VALIDATION", `${flagName} 必须指向普通文件`);
  if (info.size > MAX_INPUT_BYTES) throw new DiscoveryError("E_VALIDATION", `${flagName} 文件超过大小上限`);
  return readFile(path, "utf8");
}

export interface ReadInputOptions {
  readonly required: boolean;
  readonly flagName: string;
}

/**
 * 读取并解析 `--input`/`--confirm` 指向的 JSON 文档。`flagValue` 是 args.ts
 * 解析出的原始 flag 值（文件绝对路径或 "-"）；undefined 表示命令行未提供该 flag。
 */
export async function readInputPayload(flagValue: string | undefined, options: ReadInputOptions): Promise<Record<string, unknown> | undefined> {
  if (flagValue === undefined) {
    if (options.required) throw new DiscoveryError("E_VALIDATION", `该命令需要 ${options.flagName} FILE|-`);
    return undefined;
  }
  const text = flagValue === "-" ? await readStdin(options.flagName) : await readInputFile(flagValue, options.flagName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DiscoveryError("E_VALIDATION", `${options.flagName} 内容不是合法 JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DiscoveryError("E_VALIDATION", `${options.flagName} 必须是 JSON 对象`);
  }
  assertSafeJsonValue(parsed, options.flagName);
  return parsed as Record<string, unknown>;
}

/**
 * 把 CLI 侧推导的字段（如位置引用参数、--limit/--cursor 等 flag）合并进
 * --input 提供的 body。若同名字段已存在且取值不同，视为输入文件与命令行参数
 * 冲突并失败关闭，而不是静默让某一方"获胜"掩盖用户的疏漏。
 */
export function mergeField(body: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  if (DANGEROUS_KEYS.has(key)) throw new DiscoveryError("E_VALIDATION", `禁止的字段名 ${key}`);
  if (Object.hasOwn(body, key)) {
    if (body[key] !== value) throw new DiscoveryError("E_VALIDATION", `字段 ${key} 在输入文件与命令行参数中取值冲突`);
    return body;
  }
  return { ...body, [key]: value };
}
