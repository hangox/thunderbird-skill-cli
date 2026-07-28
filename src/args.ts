// 全局与命令级参数解析。
//
// 设计意图：CLI 的参数面是安全边界的一部分（禁止敏感 flag、禁止内联正文），
// 也是 0.3.0 邮件命令挂载后复杂度的主要来源——17+ 条邮件命令各自有不同的
// 位置引用参数与 flag 组合。与其给每条命令手写一套校验，这里提供一个通用、
// 声明式的命令级解析器（positionals + flags 的 spec），具体命令只需声明
// "需要什么"而不是"怎么解析"，从而把新增/调整命令的改动面收敛到一张表。
//
// 全局解析（--json/--human/--instance/--profile/--client/--timeout 与
// FORBIDDEN_FLAGS）保持与 Phase 1 完全一致的行为，只是从 cli.ts 搬到这里。
import { DiscoveryError } from "./discovery.js";

export const FORBIDDEN_FLAGS = ["--token", "--password", "--oauth-token", "--body", "--html"];

export interface GlobalOptions {
  human: boolean;
  json: boolean;
  instance?: string;
  profile?: string;
  clientId?: string;
  timeoutMs: number;
  commandArgs: string[];
}

/** 解析全局安全参数，返回 GlobalOptions；commandArgs 是去除全局 flag 后剩余的 argv。 */
export function parseGlobalArguments(argv: string[]): GlobalOptions {
  for (const arg of argv) {
    if (FORBIDDEN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new DiscoveryError("E_VALIDATION", `禁止使用敏感参数 ${arg.split("=")[0]}`);
    }
  }
  let human = false;
  let json = false;
  let instance: string | undefined;
  let profile: string | undefined;
  let clientId: string | undefined;
  let timeoutMs = 2_000;
  const commandArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--human") { human = true; continue; }
    if (["--instance", "--profile", "--client", "--timeout"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new DiscoveryError("E_VALIDATION", `${arg} 缺少值`);
      index += 1;
      if (arg === "--instance") instance = value;
      else if (arg === "--profile") profile = value;
      else if (arg === "--client") {
        if (!/^client_[A-Za-z0-9_-]{8,128}$/.test(value)) throw new DiscoveryError("E_VALIDATION", "--client 格式不合法");
        clientId = value;
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 250 || parsed > 30_000) throw new DiscoveryError("E_VALIDATION", "--timeout 必须在 250 到 30000 毫秒之间");
        timeoutMs = parsed;
      }
      continue;
    }
    // 全局层不再对"-"前缀 token 做白名单穷举：0.3.0 起命令级 flag 种类繁多
    // （--account/--limit/--format/--prepare/……），"这个 flag 对当前命令是否
    // 合法"统一交给 parseCommandArguments 按该命令的 spec 判定，未知 flag 依旧
    // 会在那里失败关闭（E_VALIDATION），只是判定时机从"全局"下沉到"命令级"。
    commandArgs.push(arg);
  }
  if (human && json) throw new DiscoveryError("E_VALIDATION", "--json 与 --human 不能同时使用");
  if (instance && profile) throw new DiscoveryError("E_VALIDATION", "--instance 与 --profile 不能同时使用");
  return { human, json, timeoutMs, commandArgs, ...(instance ? { instance } : {}), ...(profile ? { profile } : {}), ...(clientId ? { clientId } : {}) };
}

// ---------------------------------------------------------------------------
// 命令级参数解析：位置引用参数（opaque ref，格式只做 CLI 侧宽松校验，真正的
// 存在性/归属校验永远由扩展侧完成）+ 具名 flag（布尔/字符串/整数/枚举/
// ref/file）。这不是业务 schema（业务字段形状由 extension 侧 route 实现按
// route 定义），只是 argv 层面的语法与基础格式校验。
// ---------------------------------------------------------------------------

export type FlagType = "boolean" | "string" | "integer" | "enum" | "file" | "ref";

export interface FlagSpec {
  readonly type: FlagType;
  /** type === "ref" 时的 ref kind（如 "msg"、"draft"、"acc"、"folder"、"op"）。 */
  readonly kind?: string;
  /** type === "enum" 时的允许取值集合。 */
  readonly values?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface RefPositionalSpec {
  readonly name: string;
  readonly kind: string;
}

export interface CommandArgSpec {
  readonly positionals?: readonly RefPositionalSpec[];
  readonly flags?: Readonly<Record<string, FlagSpec>>;
}

export const EMPTY_ARG_SPEC: CommandArgSpec = {};

export type ParsedFlagValue = string | boolean;

export interface ParsedCommandArguments {
  readonly positionals: Readonly<Record<string, string>>;
  readonly flags: Readonly<Record<string, ParsedFlagValue>>;
}

/** opaque ref 的 CLI 侧宽松格式校验；真正的存在性/归属/kind 校验只在扩展侧完成。 */
export function refPattern(kind: string): RegExp {
  return new RegExp(`^${kind}_[A-Za-z0-9_-]{6,128}$`);
}

function validateFlagValue(command: string, token: string, spec: FlagSpec, value: string): string {
  switch (spec.type) {
    case "string": {
      if (value.length === 0 || value.length > 1024) throw new DiscoveryError("E_VALIDATION", `${token} 长度不合法`);
      return value;
    }
    case "file": {
      if (value.length === 0) throw new DiscoveryError("E_VALIDATION", `${token} 不能为空`);
      return value;
    }
    case "ref": {
      if (!spec.kind || !refPattern(spec.kind).test(value)) throw new DiscoveryError("E_VALIDATION", `${token} 引用格式不合法`);
      return value;
    }
    case "integer": {
      const numeric = Number(value);
      if (!Number.isInteger(numeric)) throw new DiscoveryError("E_VALIDATION", `${token} 必须是整数`);
      if (spec.minimum !== undefined && numeric < spec.minimum) throw new DiscoveryError("E_VALIDATION", `${token} 不得小于 ${spec.minimum}`);
      if (spec.maximum !== undefined && numeric > spec.maximum) throw new DiscoveryError("E_VALIDATION", `${token} 不得大于 ${spec.maximum}`);
      return value;
    }
    case "enum": {
      if (!spec.values?.includes(value)) throw new DiscoveryError("E_VALIDATION", `${token} 取值不合法`);
      return value;
    }
    case "boolean": {
      throw new DiscoveryError("E_VALIDATION", `命令 ${command} 参数 ${token} 内部定义错误：boolean flag 不应读取值`);
    }
  }
}

/**
 * 通用命令参数解析：按 spec 解析位置引用参数与具名 flag。
 * 未知 flag、重复 flag、多余位置参数、缺失必需位置参数一律 E_VALIDATION 失败关闭，
 * 不做任何"忽略未知参数"式的静默容错。
 */
export function parseCommandArguments(command: string, spec: CommandArgSpec, trailing: readonly string[]): ParsedCommandArguments {
  const positionalSpecs = spec.positionals ?? [];
  const flagSpecs = spec.flags ?? {};
  const positionalValues: string[] = [];
  const flags: Record<string, ParsedFlagValue> = {};
  const seenFlags = new Set<string>();

  for (let index = 0; index < trailing.length; index += 1) {
    const token = trailing[index];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const flagSpec = flagSpecs[token];
      if (!flagSpec) throw new DiscoveryError("E_VALIDATION", `命令 ${command} 不支持参数 ${token}`);
      if (seenFlags.has(token)) throw new DiscoveryError("E_VALIDATION", `命令 ${command} 参数 ${token} 重复`);
      seenFlags.add(token);
      if (flagSpec.type === "boolean") { flags[token] = true; continue; }
      const value = trailing[index + 1];
      if (value === undefined || value.startsWith("--")) throw new DiscoveryError("E_VALIDATION", `${token} 缺少值`);
      index += 1;
      flags[token] = validateFlagValue(command, token, flagSpec, value);
      continue;
    }
    if (positionalValues.length >= positionalSpecs.length) throw new DiscoveryError("E_VALIDATION", `命令 ${command} 包含未知或重复参数`);
    const positionalSpec = positionalSpecs[positionalValues.length];
    if (!positionalSpec) throw new DiscoveryError("E_VALIDATION", `命令 ${command} 包含未知或重复参数`);
    if (!refPattern(positionalSpec.kind).test(token)) throw new DiscoveryError("E_VALIDATION", `${positionalSpec.name} 格式不合法`);
    positionalValues.push(token);
  }

  if (positionalValues.length < positionalSpecs.length) {
    const missing = positionalSpecs[positionalValues.length];
    throw new DiscoveryError("E_VALIDATION", `命令 ${command} 缺少 ${missing?.name ?? "位置参数"}`);
  }

  const positionals: Record<string, string> = {};
  positionalSpecs.forEach((positionalSpec, index) => {
    positionals[positionalSpec.name] = positionalValues[index] as string;
  });
  return { positionals, flags };
}
