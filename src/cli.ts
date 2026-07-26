#!/usr/bin/env node
import { COMMANDS, findCommand } from "./contracts/commands.js";
import { CLI_SCHEMA_VERSION, createRequestId, type ErrorCode, type ErrorEnvelope, type SuccessEnvelope } from "./contracts/envelope.js";
import { createSigningIdentityInKeychain, loadSigningIdentityFromKeychain } from "./auth.js";
import { discoverInstances, DiscoveryError, type DiscoveredInstance } from "./discovery.js";
import { locateXpi, revealInFinder, XPI_FILE_NAME } from "./xpi.js";
import { productVersion } from "./version.js";
import { beginPairing, fetchStatus, TransportError } from "./transport.js";

const EXIT = { OK: 0, USAGE: 2, NOT_READY: 3, AUTH: 4, POLICY: 5, NOT_FOUND: 6, TEMPORARY: 7, INTERNAL: 10 } as const;
const FORBIDDEN_FLAGS = ["--token", "--password", "--oauth-token", "--body", "--html"];

interface GlobalOptions {
  human: boolean;
  json: boolean;
  instance?: string;
  profile?: string;
  clientId?: string;
  timeoutMs: number;
  commandArgs: string[];
}

function printHelp(): void {
  process.stdout.write([
    "thunderbird — Thunderbird Skill CLI Phase 1 compatibility spike", "",
    "用法：thunderbird [--json|--human] [--instance ID|--profile ID] [--client ID] [--timeout MS] <command> [args]", "",
    ...COMMANDS.map((command) => `  ${command.path.join(" ").padEnd(24)} ${command.summary} [${command.phase}/${command.risk}]`), "",
    "当前仅实现不访问邮件的 setup/status/doctor 配对、发现与握手底座。",
  ].join("\n") + "\n");
}

function parseArguments(argv: string[]): GlobalOptions {
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
    if (arg.startsWith("-") && arg !== "--deep" && arg !== "--reconfigure" && arg !== "--help" && arg !== "-h" && arg !== "--version") {
      throw new DiscoveryError("E_VALIDATION", `未知参数 ${arg}`);
    }
    commandArgs.push(arg);
  }
  if (human && json) throw new DiscoveryError("E_VALIDATION", "--json 与 --human 不能同时使用");
  if (instance && profile) throw new DiscoveryError("E_VALIDATION", "--instance 与 --profile 不能同时使用");
  return { human, json, timeoutMs, commandArgs, ...(instance ? { instance } : {}), ...(profile ? { profile } : {}), ...(clientId ? { clientId } : {}) };
}

function exitFor(code: ErrorCode): number {
  if (code === "E_USAGE" || code === "E_VALIDATION") return EXIT.USAGE;
  if (["E_NOT_IMPLEMENTED", "E_NOT_PAIRED", "E_THUNDERBIRD_OFFLINE", "E_AMBIGUOUS_INSTANCE", "E_PAIRING_PENDING", "E_ALREADY_PAIRED"].includes(code)) return EXIT.NOT_READY;
  if (code === "E_AUTH" || code === "E_REPLAY" || code === "E_VERSION_MISMATCH") return EXIT.AUTH;
  if (code === "E_CONFIRMATION_REQUIRED" || code === "E_POLICY_DENIED") return EXIT.POLICY;
  if (code === "E_NOT_FOUND") return EXIT.NOT_FOUND;
  if (code === "E_TIMEOUT" || code === "E_PAIRING_CHANGED") return EXIT.TEMPORARY;
  return EXIT.INTERNAL;
}

function emitError(command: string, code: ErrorCode, message: string, retryable: boolean, human: boolean, details?: Record<string, unknown>): never {
  if (human) process.stderr.write(`${message}\n`);
  else {
    const payload: ErrorEnvelope = { schemaVersion: CLI_SCHEMA_VERSION, ok: false, command, requestId: createRequestId(), error: { code, message, retryable, ...(details ? { details } : {}) } };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  process.exit(exitFor(code));
}

function emitSuccess<T>(command: string, data: T, human: boolean, startedAt: number, warnings: string[] = []): never {
  if (human) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  else {
    const payload: SuccessEnvelope<T> = { schemaVersion: CLI_SCHEMA_VERSION, ok: true, command, requestId: createRequestId(), data, meta: { durationMs: Date.now() - startedAt, truncated: false, warnings } };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
  process.exit(EXIT.OK);
}

function selectInstance(instances: DiscoveredInstance[], options: GlobalOptions): DiscoveredInstance {
  const selected = instances.filter(({ descriptor }) =>
    options.instance ? descriptor.instanceId === options.instance : options.profile ? descriptor.profileId === options.profile : true,
  );
  if (selected.length === 0) throw new DiscoveryError("E_THUNDERBIRD_OFFLINE", "未发现可用的 Thunderbird 扩展实例");
  if (selected.length > 1) throw new DiscoveryError("E_AMBIGUOUS_INSTANCE", "发现多个 Thunderbird 实例，必须使用 --instance 或 --profile 消歧");
  return selected[0] as DiscoveredInstance;
}

async function loadIdentity(options: GlobalOptions) {
  if (!options.clientId) return undefined;
  const identity = await loadSigningIdentityFromKeychain(options.clientId);
  if (!identity) throw new TransportError("E_AUTH", "未找到可用的本机 client 签名身份");
  return identity;
}

async function runStatus(options: GlobalOptions, startedAt: number): Promise<never> {
  const discovery = await discoverInstances();
  if (discovery.instances.length === 0 && discovery.rejected.length > 0) throw new DiscoveryError("E_VALIDATION", "所有 descriptor 均未通过安全校验");
  const selected = selectInstance(discovery.instances, options);
  const status = await fetchStatus(selected.descriptor, options.timeoutMs, await loadIdentity(options));
  const data = {
    instanceId: status.instanceId,
    profileId: status.profileId,
    profileLabel: selected.descriptor.profileLabel,
    protocolVersion: status.protocolVersion,
    extensionVersion: status.extensionVersion,
    pairingState: status.pairingState,
    capabilities: status.capabilities,
    authorizedAccountRefs: status.authorizedAccountRefs,
  };
  return emitSuccess("status", data, options.human, startedAt);
}

async function runSetup(options: GlobalOptions, startedAt: number): Promise<never> {
  const discovery = await discoverInstances();
  if (discovery.instances.length === 0 && discovery.rejected.length > 0) throw new DiscoveryError("E_VALIDATION", "所有 descriptor 均未通过安全校验");
  const selected = selectInstance(discovery.instances, options);
  const reconfigure = options.commandArgs.includes("--reconfigure");
  const clientId = options.clientId ?? `client_${createRequestId().slice(4).replaceAll("-", "")}`;
  let identity = await loadSigningIdentityFromKeychain(clientId);
  if (reconfigure && identity) {
    const current = await fetchStatus(selected.descriptor, options.timeoutMs, identity);
    if (current.pairingState === "paired") {
      throw new TransportError("E_NOT_PAIRED", "请先在 Thunderbird 扩展设置页显式撤销现有 client，再重试 setup --reconfigure；旧身份已保留", false);
    }
  }
  if (!identity) {
    identity = await createSigningIdentityInKeychain(clientId);
    if (!identity) throw new TransportError("E_AUTH", "无法在 macOS Keychain 创建 client 签名身份");
  }
  const intent = await beginPairing(selected.descriptor, options.timeoutMs, identity);
  return emitSuccess("setup", {
    paired: false,
    clientId,
    instanceId: selected.descriptor.instanceId,
    profileLabel: selected.descriptor.profileLabel,
    intentId: intent.intentId,
    challengeCode: intent.challengeCode,
    expiresAt: intent.expiresAt,
    action: "现在在 Thunderbird 扩展设置页核对并确认相同六位码；确认后运行 status --client " + clientId,
  }, options.human, startedAt, ["挑战码已在创建 intent 后立即输出；配对必须由 Thunderbird UI 明确确认"]);
}

async function runDoctor(options: GlobalOptions, startedAt: number): Promise<never> {
  const deep = options.commandArgs.includes("--deep");
  const discovery = await discoverInstances();
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    { name: "runtime-directory", ok: discovery.rootState === "ready", detail: discovery.rootState === "ready" ? "安全运行目录可用" : "运行目录不存在" },
    { name: "descriptor-security", ok: discovery.rejected.length === 0, detail: discovery.rejected.length === 0 ? "未发现不安全 descriptor" : `拒绝 ${discovery.rejected.length} 个 descriptor` },
    { name: "live-instances", ok: discovery.instances.length > 0, detail: `发现 ${discovery.instances.length} 个候选实例` },
  ];
  const identity = deep ? await loadIdentity(options) : undefined;
  if (deep) {
    for (const instance of discovery.instances) {
      try {
        const status = await fetchStatus(instance.descriptor, options.timeoutMs, identity);
        checks.push({ name: `handshake:${instance.descriptor.instanceId.slice(0, 13)}`, ok: true, detail: `协议 ${status.protocolVersion}，配对状态 ${status.pairingState}` });
      } catch (error) {
        checks.push({ name: `handshake:${instance.descriptor.instanceId.slice(0, 13)}`, ok: false, detail: error instanceof Error ? error.message : "握手失败" });
      }
    }
  }
  const healthy = checks.every((check) => check.ok);
  return emitSuccess("doctor", { healthy, deep, checks }, options.human, startedAt, healthy ? [] : ["诊断发现未通过项目；未访问任何邮件数据"]);
}

async function runXpi(action: "path" | "reveal", options: GlobalOptions, startedAt: number): Promise<never> {
  const located = await locateXpi();
  if (!located) throw new DiscoveryError("E_VALIDATION", "未找到随包分发的扩展 XPI；请确认安装完整");
  if (action === "path") {
    // --human 时只打印裸路径，方便直接 shell 传参
    if (options.human) { process.stdout.write(`${located.path}\n`); process.exit(EXIT.OK); }
    return emitSuccess("xpi path", { path: located.path, bytes: located.bytes, fileName: XPI_FILE_NAME }, false, startedAt);
  }
  const revealed = await revealInFinder(located.path);
  return emitSuccess("xpi reveal", { path: located.path, revealed, platform: process.platform }, options.human, startedAt,
    revealed ? ["已在 Finder 中定位 XPI；安装仍需你在 Thunderbird 内显式确认"] : ["无法调用 Finder（非 macOS 或调用失败）；请手动打开上述路径"]);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let options: GlobalOptions;
  try { options = parseArguments(process.argv.slice(2)); }
  catch (error) {
    const issue = error instanceof DiscoveryError ? error : new DiscoveryError("E_VALIDATION", "参数解析失败");
    return emitError("unknown", issue.code, issue.message, false, false);
  }
  const args = options.commandArgs;
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) { printHelp(); process.exit(EXIT.OK); }
  if (args[0] === "--version" || args[0] === "version") {
    if (args.length !== 1) return emitError("version", "E_VALIDATION", "version 不接受额外参数", false, options.human);
    // 输出产品版本，不是 envelope schema 版本
    process.stdout.write(productVersion() + "\n");
    process.exit(EXIT.OK);
  }
  const spec = findCommand(args);
  if (!spec) return emitError(args.join(" "), "E_USAGE", "未知命令", false, options.human);
  const command = spec.path.join(" ");
  const allowedArguments = command === "doctor" ? new Set(["--deep"]) : command === "setup" ? new Set(["--reconfigure"]) : new Set<string>();
  const trailing = args.slice(spec.path.length);
  if (trailing.some((arg) => !allowedArguments.has(arg)) || trailing.length !== new Set(trailing).size) {
    return emitError(command, "E_VALIDATION", `命令 ${command} 包含未知或重复参数`, false, options.human);
  }
  try {
    if (command === "status") await runStatus(options, startedAt);
    if (command === "doctor") await runDoctor(options, startedAt);
    if (command === "setup") await runSetup(options, startedAt);
    if (command === "xpi path") await runXpi("path", options, startedAt);
    if (command === "xpi reveal") await runXpi("reveal", options, startedAt);
    return emitError(command, "E_NOT_IMPLEMENTED", "该命令尚未进入当前 Phase 1 compatibility spike", false, options.human);
  } catch (error) {
    if (error instanceof DiscoveryError) return emitError(command, error.code, error.message, false, options.human);
    if (error instanceof TransportError) return emitError(command, error.code, error.message, error.retryable, options.human);
    return emitError(command, "E_INTERNAL", "内部错误", false, options.human);
  }
}

void main();
