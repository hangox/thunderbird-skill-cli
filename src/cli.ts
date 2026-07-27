#!/usr/bin/env node
// CLI 组合根：全局参数解析 -> 命令查找 -> 命令级参数解析 -> 分派 -> envelope 输出。
//
// 设计意图：本文件本身不再实现具体业务校验（那些已经拆到 args/input/output/
// session 四个模块），只做"胶水"——doctor/status/setup/xpi 是既有 Phase 1
// 基础设施命令的分派；MAIL_MOUNTS 是 0.3.0 新增的、按 contracts/routes.ts
// 冻结表挂载的全部只读/可逆/草稿-外发邮件命令的声明式路由表。
//
// message delete、calendar list/events、watch 三项本轮明确不纳入交付范围
// （见 docs/09、team 决议）：它们仍然存在于 contracts/commands.ts（供未来
// 引用与 help 展示），但这里刻意不为它们分配 arg spec 或 mail mount——
// 不接受任何参数，落到函数末尾统一的 E_NOT_IMPLEMENTED 兜底，不会被误当作
// 0.3.0 可用能力挂载出去。
//
// attachments save 是本轮唯一"一个 CLI 命令对应两条 route 且需要本机文件
// I/O"的例外，同样不进 MAIL_MOUNTS 泛化表：src/contracts/routes.ts 明确
// attachments.save（授权+元数据+一次性 fetch token）与 attachments.fetch
// （循环拉取 JSON 内联 base64 分块）都映射到该命令，且"扩展不接收也不校验
// 任何本机文件系统路径"——no-clobber/敏感路径/symlink/设备文件拒绝与安全
// 落盘完全是 CLI 的职责，见 runAttachmentsSave() 与 src/paths.ts。
import { createRequestId } from "./contracts/envelope.js";
import { findCommand } from "./contracts/commands.js";
import { ATTACHMENT_FETCH_MAX_CHUNK_ENCODED_BYTES, ATTACHMENT_FETCH_MAX_TOTAL_BYTES, findMailRoutesByCommand } from "./contracts/routes.js";
import { createSigningIdentityInKeychain, loadSigningIdentityFromKeychain } from "./auth.js";
import { discoverInstances, DiscoveryError } from "./discovery.js";
import { locateXpi, revealInFinder, XPI_FILE_NAME } from "./xpi.js";
import { productVersion } from "./version.js";
import { beginPairing, callMailRoute, fetchStatus, TransportError } from "./transport.js";
import {
  EMPTY_ARG_SPEC, parseCommandArguments, parseGlobalArguments,
  type CommandArgSpec, type GlobalOptions, type ParsedCommandArguments,
} from "./args.js";
import { EXIT, emitError, emitSuccess, printHelp } from "./output.js";
import { mergeField, readInputPayload } from "./input.js";
import { discoverAndSelect, loadOptionalIdentity, requireMailIdentity } from "./session.js";
import { openAttachmentTempFile, resolveSafeDirectory } from "./paths.js";

// ---------------------------------------------------------------------------
// 邮件命令挂载表：命令路径字符串 -> {命令级 arg spec, 输入 flag（若有）, body 构造}。
// body 字段名（messageRef/draftRef/accountRef/folderRef/limit/cursor/format/
// maxBytes/includeIdentities/operationId 等）取自 docs/03-cli-contract.md 与
// docs/02 的既有约定；具体业务字段的权威 schema 由 extension 侧按 route 实现，
// 这里是"CLI 怎么把 argv/--input 拼成请求体"这一层，不是业务校验的最终来源。
// ---------------------------------------------------------------------------

interface MailMountContext {
  readonly positionals: Readonly<Record<string, string>>;
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly input?: Record<string, unknown>;
}

interface MailMount {
  readonly spec: CommandArgSpec;
  readonly inputFlag?: string;
  readonly inputRequired?: boolean;
  readonly buildBody: (context: MailMountContext) => Record<string, unknown>;
}

const ref = (name: string, kind: string) => ({ name, kind });

const MAIL_MOUNTS: Readonly<Record<string, MailMount>> = {
  "accounts list": {
    spec: { flags: { "--include-identities": { type: "boolean" } } },
    buildBody: ({ flags }) => (flags["--include-identities"] === true ? { includeIdentities: true } : {}),
  },
  "folders list": {
    spec: { flags: { "--account": { type: "ref", kind: "acc" }, "--parent": { type: "ref", kind: "folder" } } },
    buildBody: ({ flags }) => {
      let body: Record<string, unknown> = {};
      if (typeof flags["--account"] === "string") body = mergeField(body, "accountRef", flags["--account"]);
      if (typeof flags["--parent"] === "string") body = mergeField(body, "parentRef", flags["--parent"]);
      return body;
    },
  },
  search: {
    spec: { flags: { "--input": { type: "file" }, "--limit": { type: "integer", minimum: 1, maximum: 100 }, "--cursor": { type: "string" } } },
    inputFlag: "--input",
    buildBody: ({ flags, input }) => {
      let body: Record<string, unknown> = { ...(input ?? {}) };
      if (typeof flags["--limit"] === "string") body = mergeField(body, "limit", Number(flags["--limit"]));
      if (typeof flags["--cursor"] === "string") body = mergeField(body, "cursor", flags["--cursor"]);
      return body;
    },
  },
  recent: {
    spec: { flags: { "--account": { type: "ref", kind: "acc" }, "--folder": { type: "ref", kind: "folder" }, "--limit": { type: "integer", minimum: 1, maximum: 100 } } },
    buildBody: ({ flags }) => {
      let body: Record<string, unknown> = {};
      if (typeof flags["--account"] === "string") body = mergeField(body, "accountRef", flags["--account"]);
      if (typeof flags["--folder"] === "string") body = mergeField(body, "folderRef", flags["--folder"]);
      if (typeof flags["--limit"] === "string") body = mergeField(body, "limit", Number(flags["--limit"]));
      return body;
    },
  },
  "message get": {
    spec: {
      positionals: [ref("messageRef", "msg")],
      flags: { "--format": { type: "enum", values: ["text", "markdown", "raw"] }, "--max-bytes": { type: "integer", minimum: 1, maximum: 262_144 } },
    },
    buildBody: ({ positionals, flags }) => {
      let body: Record<string, unknown> = { messageRef: positionals.messageRef };
      if (typeof flags["--format"] === "string") body = mergeField(body, "format", flags["--format"]);
      if (typeof flags["--max-bytes"] === "string") body = mergeField(body, "maxBytes", Number(flags["--max-bytes"]));
      return body;
    },
  },
  "message open": {
    spec: { positionals: [ref("messageRef", "msg")] },
    buildBody: ({ positionals }) => ({ messageRef: positionals.messageRef }),
  },
  "message mark": {
    spec: { flags: { "--input": { type: "file" } } },
    inputFlag: "--input",
    inputRequired: true,
    buildBody: ({ input }) => ({ ...(input ?? {}) }),
  },
  "message move": {
    spec: { flags: { "--input": { type: "file" } } },
    inputFlag: "--input",
    inputRequired: true,
    buildBody: ({ input }) => ({ ...(input ?? {}) }),
  },
  "message trash": {
    spec: { flags: { "--input": { type: "file" } } },
    inputFlag: "--input",
    inputRequired: true,
    buildBody: ({ input }) => ({ ...(input ?? {}) }),
  },
  "draft create": {
    spec: { flags: { "--input": { type: "file" } } },
    inputFlag: "--input",
    inputRequired: true,
    buildBody: ({ input }) => ({ ...(input ?? {}) }),
  },
  "draft update": {
    spec: { positionals: [ref("draftRef", "draft")], flags: { "--input": { type: "file" } } },
    inputFlag: "--input",
    inputRequired: true,
    buildBody: ({ positionals, input }) => mergeField({ ...(input ?? {}) }, "draftRef", positionals.draftRef),
  },
  "draft open": {
    spec: { positionals: [ref("draftRef", "draft")] },
    buildBody: ({ positionals }) => ({ draftRef: positionals.draftRef }),
  },
  "attachments list": {
    spec: { positionals: [ref("messageRef", "msg")] },
    buildBody: ({ positionals }) => ({ messageRef: positionals.messageRef }),
  },
  "operations get": {
    spec: { positionals: [ref("operationId", "op")] },
    buildBody: ({ positionals }) => ({ operationId: positionals.operationId }),
  },
  "operations undo": {
    spec: { positionals: [ref("undoToken", "undo")] },
    buildBody: ({ positionals }) => ({ undoToken: positionals.undoToken }),
  },
};

// draft send 是"一个 CLI 命令对应两条 route"的例外之一（prepare/confirm
// 两阶段确认，见 docs/03 §发送确认），因此单独处理，不进 MAIL_MOUNTS 泛化表。
const DRAFT_SEND_SPEC: CommandArgSpec = {
  positionals: [ref("draftRef", "draft")],
  flags: { "--prepare": { type: "boolean" }, "--confirm": { type: "file" } },
};

// attachments save 是另一个例外：授权（attachments.save）与分块拉取
// （attachments.fetch）两条 route + 本机安全落盘，见 runAttachmentsSave()。
const ATTACHMENTS_SAVE_SPEC: CommandArgSpec = {
  flags: { "--input": { type: "file" } },
};

const COMMAND_ARG_SPECS: Readonly<Record<string, CommandArgSpec>> = {
  doctor: { flags: { "--deep": { type: "boolean" } } },
  setup: { flags: { "--reconfigure": { type: "boolean" } } },
  status: EMPTY_ARG_SPEC,
  "xpi path": EMPTY_ARG_SPEC,
  "xpi reveal": EMPTY_ARG_SPEC,
  "draft send": DRAFT_SEND_SPEC,
  "attachments save": ATTACHMENTS_SAVE_SPEC,
  ...Object.fromEntries(Object.entries(MAIL_MOUNTS).map(([command, mount]) => [command, mount.spec])),
};

async function runStatus(options: GlobalOptions, startedAt: number): Promise<never> {
  const selected = await discoverAndSelect(options);
  const status = await fetchStatus(selected.descriptor, options.timeoutMs, await loadOptionalIdentity(options));
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

async function runSetup(options: GlobalOptions, parsed: ParsedCommandArguments, startedAt: number): Promise<never> {
  const selected = await discoverAndSelect(options);
  const reconfigure = parsed.flags["--reconfigure"] === true;
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

async function runDoctor(options: GlobalOptions, parsed: ParsedCommandArguments, startedAt: number): Promise<never> {
  const deep = parsed.flags["--deep"] === true;
  const discovery = await discoverInstances();
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    { name: "runtime-directory", ok: discovery.rootState === "ready", detail: discovery.rootState === "ready" ? "安全运行目录可用" : "运行目录不存在" },
    { name: "descriptor-security", ok: discovery.rejected.length === 0, detail: discovery.rejected.length === 0 ? "未发现不安全 descriptor" : `拒绝 ${discovery.rejected.length} 个 descriptor` },
    { name: "live-instances", ok: discovery.instances.length > 0, detail: `发现 ${discovery.instances.length} 个候选实例` },
  ];
  const identity = deep ? await loadOptionalIdentity(options) : undefined;
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

async function runMailMount(
  command: string,
  commandPath: readonly string[],
  mount: MailMount,
  parsed: ParsedCommandArguments,
  options: GlobalOptions,
  startedAt: number,
): Promise<never> {
  // 顺序刻意如此：先校验本地身份/发现实例（无网络、代价低），再读取可能来自
  // stdin 的输入体——避免用户在 --client 缺失时白白通过管道喂入大量正文。
  const identity = await requireMailIdentity(options);
  const instance = await discoverAndSelect(options);
  const input = mount.inputFlag
    ? await readInputPayload(parsed.flags[mount.inputFlag] as string | undefined, { required: Boolean(mount.inputRequired), flagName: mount.inputFlag })
    : undefined;
  const body = mount.buildBody({ positionals: parsed.positionals, flags: parsed.flags, ...(input ? { input } : {}) });
  const route = findMailRoutesByCommand(commandPath)[0];
  if (!route) throw new Error(`mail route 未找到：${command}`);
  const data = await callMailRoute(instance.descriptor, route, body, options.timeoutMs, identity);
  return emitSuccess(command, data, options.human, startedAt);
}

async function runDraftSend(parsed: ParsedCommandArguments, options: GlobalOptions, startedAt: number): Promise<never> {
  const hasPrepare = parsed.flags["--prepare"] === true;
  const confirmFile = typeof parsed.flags["--confirm"] === "string" ? parsed.flags["--confirm"] : undefined;
  if (hasPrepare === (confirmFile !== undefined)) {
    throw new DiscoveryError("E_VALIDATION", "draft send 必须且只能指定 --prepare 或 --confirm FILE|-");
  }
  const identity = await requireMailIdentity(options);
  const instance = await discoverAndSelect(options);
  const routes = findMailRoutesByCommand(["draft", "send"]);
  if (hasPrepare) {
    const route = routes.find((candidate) => candidate.id === "drafts.send.prepare");
    if (!route) throw new Error("drafts.send.prepare 路由缺失");
    const data = await callMailRoute(instance.descriptor, route, { draftRef: parsed.positionals.draftRef }, options.timeoutMs, identity);
    return emitSuccess("draft send", data, options.human, startedAt);
  }
  const route = routes.find((candidate) => candidate.id === "drafts.send.confirm");
  if (!route) throw new Error("drafts.send.confirm 路由缺失");
  const confirmPayload = await readInputPayload(confirmFile, { required: true, flagName: "--confirm" });
  const body = mergeField({ ...(confirmPayload ?? {}) }, "draftRef", parsed.positionals.draftRef);
  const data = await callMailRoute(instance.descriptor, route, body, options.timeoutMs, identity);
  return emitSuccess("draft send", data, options.human, startedAt);
}

// ---------------------------------------------------------------------------
// attachments save：授权（attachments.save）+ 循环分块拉取（attachments.fetch）
// + 本机安全落盘（src/paths.ts）。
//
// 响应字段名（name/contentType/size/digest/fetchToken；attachments.fetch 的
// chunk/cursor）是本命令行层面按 contracts/routes.ts 冻结的常量与既有
// digest 约定（"sha256:<hex>"，与 draft send 的 draftRevision 一致）推导出的
// 约定，不是业务 schema 的权威来源——扩展侧尚未实现这两条 route 的真实
// handler（Task #29/#30 之外的独立后续任务）；一旦落地，如字段命名不同，只
// 需要调整本文件这一小段解析/构造逻辑，不影响 CLI 外壳其余部分。
// ---------------------------------------------------------------------------

interface AttachmentsSaveAuthorization {
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly digest: string;
  readonly fetchToken: string;
}

function parseAttachmentsSaveAuthorization(value: unknown): AttachmentsSaveAuthorization {
  if (typeof value !== "object" || value === null) throw new TransportError("E_VALIDATION", "attachments.save 响应格式不合法");
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || record.name.length === 0) throw new TransportError("E_VALIDATION", "attachments.save 响应缺少合法 name");
  if (typeof record.contentType !== "string" || record.contentType.length === 0) throw new TransportError("E_VALIDATION", "attachments.save 响应缺少合法 contentType");
  if (!Number.isInteger(record.size) || (record.size as number) < 0) throw new TransportError("E_VALIDATION", "attachments.save 响应 size 不合法");
  if (typeof record.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.digest)) throw new TransportError("E_VALIDATION", "attachments.save 响应 digest 不合法");
  if (typeof record.fetchToken !== "string" || record.fetchToken.length === 0) throw new TransportError("E_VALIDATION", "attachments.save 响应缺少 fetchToken");
  return { name: record.name, contentType: record.contentType, size: record.size as number, digest: record.digest, fetchToken: record.fetchToken };
}

interface AttachmentsFetchChunk {
  readonly chunkBase64: string;
  readonly nextCursor: string | null;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function parseAttachmentsFetchChunk(value: unknown): AttachmentsFetchChunk {
  if (typeof value !== "object" || value === null) throw new TransportError("E_VALIDATION", "attachments.fetch 响应格式不合法");
  const record = value as Record<string, unknown>;
  if (typeof record.chunk !== "string" || !BASE64_PATTERN.test(record.chunk)) throw new TransportError("E_VALIDATION", "attachments.fetch 响应 chunk 不是合法 base64");
  if (record.cursor !== null && typeof record.cursor !== "string") throw new TransportError("E_VALIDATION", "attachments.fetch 响应 cursor 不合法");
  return { chunkBase64: record.chunk, nextCursor: record.cursor as string | null };
}

/** 附件原始总大小不可能超过这个块数（每块至少推进一些进度）；防止扩展异常/恶意场景下 cursor 永不为 null 造成无限轮询。 */
const MAX_ATTACHMENT_FETCH_ITERATIONS = 20_000;

async function runAttachmentsSave(parsed: ParsedCommandArguments, options: GlobalOptions, startedAt: number): Promise<never> {
  const identity = await requireMailIdentity(options);
  const instance = await discoverAndSelect(options);
  const input = await readInputPayload(parsed.flags["--input"] as string | undefined, { required: true, flagName: "--input" });
  const attachmentRef = input?.attachmentRef;
  const directory = input?.directory;
  if (typeof attachmentRef !== "string") throw new DiscoveryError("E_VALIDATION", "--input 缺少 attachmentRef 字段");
  if (typeof directory !== "string") {
    throw new DiscoveryError("E_VALIDATION", "--input 缺少 directory 字段（本机绝对目标目录；此字段只在 CLI 本地使用，不会发送给扩展）");
  }
  // 尽早校验目标目录本身的安全性（绝对路径/存在/非 symlink 解析异常/非
  // 敏感路径/非设备文件），避免对一个注定写不进去的目录先浪费一次授权+
  // 网络往返；文件名相关的 no-clobber 检查需要 attachments.save 返回的
  // metadata.name，只能等授权完成后在 openAttachmentTempFile() 里做。
  await resolveSafeDirectory(directory);

  const routes = findMailRoutesByCommand(["attachments", "save"]);
  const saveRoute = routes.find((candidate) => candidate.id === "attachments.save");
  const fetchRoute = routes.find((candidate) => candidate.id === "attachments.fetch");
  if (!saveRoute || !fetchRoute) throw new Error("attachments.save/attachments.fetch 路由缺失");

  const authorized = await callMailRoute(instance.descriptor, saveRoute, { attachmentRef }, options.timeoutMs, identity);
  const metadata = parseAttachmentsSaveAuthorization(authorized);
  if (metadata.size > ATTACHMENT_FETCH_MAX_TOTAL_BYTES) {
    // 双重保险：扩展本应在授权阶段就因超限拒绝签发 fetch token，这里是纵深防御。
    throw new TransportError("E_VALIDATION", "附件总大小超过契约硬上限");
  }

  // 目标同目录安全临时文件在这里创建（O_NOFOLLOW|O_EXCL），早于任何网络拉取，
  // 让路径穿越/symlink/设备文件/敏感路径/已存在等本地校验尽早失败，不浪费
  // 一次授权+网络往返。
  const handle = await openAttachmentTempFile(directory, metadata.name);
  try {
    let cursor: string | null = null;
    let first = true;
    let totalDecodedBytes = 0;
    let iterations = 0;
    while (first || cursor !== null) {
      first = false;
      iterations += 1;
      if (iterations > MAX_ATTACHMENT_FETCH_ITERATIONS) throw new TransportError("E_TIMEOUT", "附件分块拉取轮询次数超过安全上限", false);
      const requestedCursor: string | null = cursor;
      const body: Record<string, unknown> = { fetchToken: metadata.fetchToken, ...(requestedCursor !== null ? { cursor: requestedCursor } : {}) };
      const response = await callMailRoute(instance.descriptor, fetchRoute, body, options.timeoutMs, identity);
      const chunk = parseAttachmentsFetchChunk(response);
      // 服务端返回的下一个 cursor 与本次请求所用的 cursor 完全相同，说明没有
      // 任何进展（重放或异常响应），必须失败关闭，否则会无限轮询。
      if (chunk.nextCursor !== null && chunk.nextCursor === requestedCursor) {
        throw new TransportError("E_VALIDATION", "attachments.fetch 返回的 cursor 未推进，疑似重放或异常响应");
      }
      if (chunk.chunkBase64.length > 0) {
        if (Buffer.byteLength(chunk.chunkBase64, "utf8") > ATTACHMENT_FETCH_MAX_CHUNK_ENCODED_BYTES) {
          throw new TransportError("E_VALIDATION", "attachments.fetch 单块 base64 长度超过契约硬上限");
        }
        const decoded = Buffer.from(chunk.chunkBase64, "base64");
        totalDecodedBytes += decoded.length;
        if (totalDecodedBytes > metadata.size) throw new TransportError("E_VALIDATION", "附件实际拉取字节超过声明大小");
        await handle.write(decoded);
      }
      cursor = chunk.nextCursor;
    }
    const result = await handle.finish({ totalBytes: metadata.size, sha256Digest: metadata.digest });
    return emitSuccess("attachments save", {
      attachmentRef,
      path: result.finalPath,
      bytes: result.bytesWritten,
      name: metadata.name,
      contentType: metadata.contentType,
    }, options.human, startedAt);
  } catch (error) {
    await handle.abort();
    throw error;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  let options: GlobalOptions;
  try { options = parseGlobalArguments(process.argv.slice(2)); }
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
  const trailing = args.slice(spec.path.length);
  const argSpec = COMMAND_ARG_SPECS[command] ?? EMPTY_ARG_SPEC;
  let parsed: ParsedCommandArguments;
  try { parsed = parseCommandArguments(command, argSpec, trailing); }
  catch (error) {
    const issue = error instanceof DiscoveryError ? error : new DiscoveryError("E_VALIDATION", "参数解析失败");
    return emitError(command, issue.code, issue.message, false, options.human);
  }
  try {
    if (command === "status") await runStatus(options, startedAt);
    if (command === "doctor") await runDoctor(options, parsed, startedAt);
    if (command === "setup") await runSetup(options, parsed, startedAt);
    if (command === "xpi path") await runXpi("path", options, startedAt);
    if (command === "xpi reveal") await runXpi("reveal", options, startedAt);
    const mount = MAIL_MOUNTS[command];
    if (mount) await runMailMount(command, spec.path, mount, parsed, options, startedAt);
    if (command === "draft send") await runDraftSend(parsed, options, startedAt);
    if (command === "attachments save") await runAttachmentsSave(parsed, options, startedAt);
    // message delete / calendar list|events / watch 及其余未接线命令统一落到这里。
    return emitError(command, "E_NOT_IMPLEMENTED", "该命令本轮未纳入交付范围或邮件适配层尚未接线", false, options.human);
  } catch (error) {
    if (error instanceof DiscoveryError) return emitError(command, error.code, error.message, false, options.human);
    if (error instanceof TransportError) return emitError(command, error.code, error.message, error.retryable, options.human);
    return emitError(command, "E_INTERNAL", "内部错误", false, options.human);
  }
}

void main();
