// 执行级 Experiment 测试夹具。
//
// 设计意图：不做源码字符串断言，而是把 extension/bridge/api.js 原封不动地跑起来，
// 拿到它内部真实的 preflight/dispatch 闭包，再用合成请求驱动它们。
//
// 关键手法：api.js 里 `createLoopbackServer` 是顶层函数声明，在 VM 里会成为全局对象属性；
// 而 start() 通过作用域链引用它。因此在调用 start() 之前替换掉全局上的这个属性，
// 就能俘获真实的 (preflight, dispatch) 而不改动被测源码一个字符。
import { createHash, generateKeyPairSync, webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdirSync, existsSync, statSync, chmodSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import vm from "node:vm";
import { canonicalizeRequest, signRequest } from "../../dist/auth.js";

export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function nsIFile(path) {
  return {
    path,
    get leafName() { return basename(this.path); },
    clone() { return nsIFile(this.path); },
    append(name) { this.path = join(this.path, name); },
    exists() { return existsSync(this.path); },
    create(_type, perms) { mkdirSync(this.path, { recursive: true, mode: perms }); },
    isDirectory() { return existsSync(this.path) && statSync(this.path).isDirectory(); },
    isSymlink() { return false; },
    remove() { unlinkSync(this.path); },
    get permissions() { return existsSync(this.path) ? statSync(this.path).mode & 0o7777 : 0; },
    set permissions(value) { if (existsSync(this.path)) chmodSync(this.path, value); },
  };
}

function cryptoHash() {
  let chunks = [];
  return {
    SHA256: 2,
    init() { chunks = []; },
    update(data) { chunks.push(Buffer.from(data)); },
    finish() { return createHash("sha256").update(Buffer.concat(chunks)).digest("latin1"); },
  };
}

// Task #47 生命周期回归：真实 Gecko 的 `ExtensionCommon.EventManager` 会把
// 自己的注册状态绑定到构造时传入的 `context`——那个 context 死亡（比如
// classic background 脚本被销毁重建）时，EventManager 内部自动触发
// unregister，把 register() 返回的清理回调跑一遍。这份夹具此前完全没有
// `ExtensionCommon.EventManager`（`typeof ExtensionCommon.EventManager`
// 是 `"undefined"`），api.js 里 `createEventManager()` 因此永远走那条
// "退化实现"分支——那条分支不认识 context 生命周期，无法暴露
// "getAPI() 被同一个 __tbSkillState 复用、但 context 已经换了一个" 这类
// 生命周期 bug。这里补一个足够真实的最小 EventManager 模拟：
// - `context.callOnClose(closeable)` 登记一个"context 关闭时执行"的回调
//   （真实 Gecko API 原名如此，`ExtensionCommon.EventManager` 内部就是靠
//   它自动 unregister 的）。
// - `context.close()` 触发全部已登记回调，模拟"这个 background context
//   被销毁了"。
function makeBackgroundContext() {
  const closeCallbacks = [];
  return {
    extension: { rootURI: "resource://test/" },
    callOnClose(closeable) { closeCallbacks.push(closeable); },
    close() { for (const closeable of closeCallbacks.splice(0)) closeable.close(); },
  };
}

class FakeEventManager {
  constructor({ context, register }) {
    this.listeners = new Set();
    this.unregister = null;
    // 真实 Gecko 的 EventManager 实例在构造时把自己永久绑定到这一个
    // `context`——`register`/`fire` 回调本身不重新校验 context 是否还活着，
    // 但框架层面等效于"这个 context 死了之后，绑定它的 EventManager 也
    // 一并报废"：无论是因为跨 compartment 的 exportFunction 引用变成
    // dead object，还是内部 shouldFire()/context.unloaded 门禁，最终
    // 可观察的结果都是同一个——close() 之后这个实例不能再被有效地重新
    // addListener() 复活。这一点必须建模出来，否则"getAPI() 复用了绑定在
    // 旧 context 上的 event manager"这个 Task #47 bug 场景会被新监听者的
    // 重新注册悄悄"自愈"，测出一个假阴性（旧版本的这份 mock 就踩了这个坑：
    // 允许 close() 之后 addListener() 无条件重新 register()，导致回归测试
    // 在有 bug 的源码上也能通过）。
    this.closed = false;
    context.callOnClose({
      close: () => {
        this.closed = true;
        this.listeners.clear();
        if (this.unregister) { this.unregister(); this.unregister = null; }
      },
    });
    this.register = register;
  }
  api() {
    const listeners = this.listeners;
    const fire = {
      async(...args) { for (const listener of listeners) listener(...args); },
      sync(...args) { for (const listener of listeners) listener(...args); },
    };
    return {
      addListener: (listener) => {
        if (this.closed) return; // 绑定的 context 已死：静默失效，不重新 register()。
        listeners.add(listener);
        if (listeners.size === 1) this.unregister = this.register(fire);
      },
      removeListener: (listener) => {
        listeners.delete(listener);
        if (listeners.size === 0 && this.unregister) { this.unregister(); this.unregister = null; }
      },
      hasListener: (listener) => listeners.has(listener),
    };
  }
}

function safeOutputStream() {
  let target = null;
  let buffer = "";
  const stream = {
    init(file) { target = file.path; buffer = ""; },
    write(value, length) { buffer += value.slice(0, length); return length; },
    flush() {},
    finish() { writeFileSync(target, Buffer.from(buffer, "latin1"), { mode: 0o600 }); },
    QueryInterface() { return stream; },
  };
  return stream;
}

/**
 * 启动一份真实的 Experiment API 实例。
 * @param {{prefs?: Map<string,string>, root?: string}} options
 */
export async function startExperiment(options = {}) {
  const source = await readFile(new URL("../../extension/bridge/api.js", import.meta.url), "utf8");
  const root = options.root ?? await mkdtemp(join(tmpdir(), "tb-experiment-"));
  const prefs = options.prefs ?? new Map();
  const observers = [];

  const hiddenWindow = {
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    atob: (value) => Buffer.from(value, "base64").toString("latin1"),
    setTimeout: (...args) => { const handle = setTimeout(...args); handle.unref?.(); return handle; },
    clearTimeout: (handle) => clearTimeout(handle),
  };

  const contracts = {
    "@mozilla.org/network/protocol;1?name=resource": { getService: () => ({ ALLOW_CONTENT_ACCESS: 1, setSubstitutionWithFlags() {}, setSubstitution() {} }) },
    "@mozilla.org/security/hash;1": { createInstance: cryptoHash },
    "@mozilla.org/network/safe-file-output-stream;1": { createInstance: safeOutputStream },
    "@mozilla.org/file/local;1": { createInstance: () => ({ initWithPath() {} }) },
    "@mozilla.org/process/util;1": { createInstance: () => ({ init() {}, run() {} }) },
    "@mozilla.org/network/server-socket;1": { createInstance: () => ({ initSpecialConnection() {}, asyncListen() {}, close() {}, port: 49_152 }) },
    "@mozilla.org/scriptableinputstream;1": { createInstance: () => ({ init() {}, read: () => "" }) },
  };

  const sandbox = {
    Cc: new Proxy({}, { get: (_target, key) => contracts[key] ?? { getService: () => ({}), createInstance: () => ({}) } }),
    Ci: new Proxy({}, { get: (_target, key) => (key === "nsIFile" ? { DIRECTORY_TYPE: 1 } : {}) }),
    Cr: { NS_BASE_STREAM_WOULD_BLOCK: Symbol("would-block"), NS_BASE_STREAM_CLOSED: Symbol("closed"), NS_ERROR_ABORT: Symbol("abort") },
    ChromeUtils: { generateQI: () => function QueryInterface() { return this; } },
    ExtensionCommon: { ExtensionAPI: class {}, EventManager: FakeEventManager },
    Services: {
      appShell: { hiddenDOMWindow: hiddenWindow },
      appinfo: { processID: process.pid },
      tm: { mainThread: {} },
      obs: {
        addObserver: (observer, topic) => observers.push({ observer, topic }),
        removeObserver: () => {},
        notifyObservers: () => {},
      },
      dirsvc: { get: (key) => nsIFile(key === "ProfD" ? join(root, "profile") : join(root, "tmp")) },
      prefs: {
        getStringPref: (name, fallback) => (prefs.has(name) ? prefs.get(name) : (fallback !== undefined ? fallback : (() => { throw new Error("pref 不存在"); })())),
        setStringPref: (name, value) => prefs.set(name, value),
        clearUserPref: (name) => prefs.delete(name),
      },
    },
    console: { info() {}, error() {}, warn() {} },
    URL, TextEncoder, TextDecoder, Uint8Array, Uint32Array, Buffer, Date, Math, JSON, Promise, Symbol, Object, Array, String, Number, BigInt, Error, RegExp, Map, Set, isNaN, parseInt,
  };
  sandbox.globalThis = sandbox;
  mkdirSync(join(root, "tmp"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "profile"), { recursive: true, mode: 0o700 });
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  // 俘获真实的 preflight / dispatch。
  let captured = null;
  sandbox.createLoopbackServer = (preflight, dispatch) => {
    captured = { preflight, dispatch };
    return { port: 49_152, stop(callback) { callback?.(); } };
  };

  const instance = new sandbox.thunderbirdSkillBridge();
  let currentContext = makeBackgroundContext();
  let api = instance.getAPI(currentContext).thunderbirdSkillBridge;
  const started = await api.start();

  const harness = {
    root,
    prefs,
    port: started.port,
    get api() { return api; },
    // Task #48 测试专用后门：直接读取 api.js 内部真实的 `state` 对象
    // （`globalThis.__tbSkillState`），供需要构造"挑战码已过期"这类场景的
    // 测试直接改写 `state.pending.expiresAt` 为过去的时间戳——真实
    // PAIRING_TTL_MS 是 5 分钟，测试不应该也不需要真的等 5 分钟真实时间。
    // 只暴露读取（能拿到的是同一个可变对象的引用，调用方可以直接改它的
    // 字段），不新增任何写入包装逻辑，尽量不引入需要额外维护的抽象。
    get state() { return sandbox.__tbSkillState; },
    get preflight() { return captured.preflight; },
    get dispatch() { return captured.dispatch; },
    // 真实 HTTP parser 入口：把原始 HTTP/1.1 报文交给 api.js 内部真正的
    // splitRequestHead + parseRequestHead，返回可直接喂给 preflight/dispatch 的 request。
    parseRaw(rawText) {
      const split = sandbox.splitRequestHead(rawText);
      if (!split) throw new Error("报文不完整");
      const request = sandbox.parseRequestHead(split.head);
      request.bodyText = split.rest;
      request.deadlineAt = Date.now() + 5_000;
      request.isCancelled = () => false;
      return request;
    },
    descriptor: () => JSON.parse(readFileSync(started.descriptorPath, "utf8")),
    sessionToken: () => JSON.parse(readFileSync(api === null ? "" : started.descriptorPath, "utf8")).sessionToken,
    onShutdown: () => instance.onShutdown(true),
    // Task #47 生命周期回归专用：模拟"当前 classic background context 被
    // 销毁、Thunderbird 用一个新 context 重新调用 getAPI()"——不重启 HTTP
    // 服务（`captured`/`started` 不变，与真实 bug 场景"HTTP 服务仍在线"
    // 一致），只重新走一次 getAPI(newContext)，并把 `harness.api` 更新为
    // 新返回的 api 引用（`get api()` 因此总是拿到最新的那份）。旧 context
    // 的 `close()` 会通过 FakeEventManager 触发旧 operationChannel/
    // pairingRevokedEvent 的自动 unregister，真实复现"旧 context 死后
    // fireEvent 变 null"这条 Gecko 行为，而不是空洞地换一个 context 对象。
    reconnectBackgroundContext() {
      currentContext.close();
      currentContext = makeBackgroundContext();
      api = instance.getAPI(currentContext).thunderbirdSkillBridge;
      return api;
    },
    cleanup: async () => { sandbox.__tbSkillState = null; await rm(root, { recursive: true, force: true }); },
  };
  return harness;
}

export function makeIdentity(clientId = "client_harness01") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    clientId,
    publicKeyAlgorithm: "Ed25519",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

let requestCounter = 0;

/**
 * 构造一个可直接喂给真实 preflight/dispatch 的请求对象，签名与扩展 canonical 完全一致。
 */
export function buildRequest(harness, options = {}) {
  const descriptor = options.descriptor ?? harness.descriptor();
  const method = options.method ?? "GET";
  const path = options.path ?? "/v1/status";
  const bodyText = options.bodyText ?? "";
  const host = options.host ?? `127.0.0.1:${descriptor.port}`;
  const requestId = options.requestId ?? `cli_123e4567-e89b-12d3-a456-${String(426_614_174_000 + (requestCounter += 1)).padStart(12, "0")}`;
  const timestamp = options.timestamp ?? String(Date.now());
  const nonce = options.nonce ?? createHash("sha256").update(`${requestId}`).digest("hex").slice(0, 32);
  const bodySha256 = options.bodySha256 ?? createHash("sha256").update(bodyText).digest("hex");
  // 用 hasOwn 而不是 ??：显式传 null 表示"完全不发送该 header"，不能被 ?? 回落成 descriptor 的值。
  const pairingEpoch = Object.hasOwn(options, "pairingEpoch") ? options.pairingEpoch : descriptor.pairingEpoch;

  const headers = new Map([
    ["host", host],
    ["authorization", `Bearer ${options.sessionToken ?? descriptor.sessionToken}`],
    ["content-type", options.contentType ?? "application/json"],
    ["x-thunderbird-client", "thunderbird-skill-cli"],
    ["x-thunderbird-protocol", options.protocol ?? "1"],
    ["x-thunderbird-client-version", options.clientVersion ?? "0.4.0"],
    ["x-request-id", requestId],
    ["x-request-timestamp", timestamp],
    ["x-request-nonce", nonce],
    ["x-content-sha256", bodySha256],
  ]);
  if (pairingEpoch !== null) headers.set("x-thunderbird-pairing-epoch", pairingEpoch);

  if (options.identity) {
    const canonical = {
      method, path, host,
      protocolVersion: Number(options.protocol ?? "1"),
      requestId, timestamp, nonce, bodySha256,
      pairingEpoch: options.signedEpoch ?? pairingEpoch ?? "",
    };
    headers.set("x-thunderbird-client-id", options.clientIdHeader ?? options.identity.clientId);
    headers.set("x-request-signature", options.signature ?? signRequest(canonical, options.identity));
  }
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) headers.set(name.toLowerCase(), value);

  // 模拟真实 parser 的产物：rawHeaders 是未 trim 的 field value，标准编码下前置一个 OWS 分隔符。
  const rawHeaders = new Map();
  for (const [name, value] of headers) rawHeaders.set(name, ` ${value}`);
  for (const [name, value] of Object.entries(options.rawHeaderOverrides ?? {})) rawHeaders.set(name.toLowerCase(), value);

  return {
    method, path, headers, rawHeaders,
    contentLength: Buffer.byteLength(bodyText),
    bodyText,
    authenticated: null,
    pairingCandidate: null,
    // 默认 5s，测试超时/无监听者路径时可传 options.deadlineMs 缩短，不必真的等待。
    deadlineAt: Date.now() + (options.deadlineMs ?? 5_000),
    isCancelled: () => false,
  };
}

/**
 * 测试专用 capability 注入：直接调用真实的 thunderbirdSkillBridge.setMailCapabilities
 * （生产环境里是账号/能力授权 UI 才会调用的同一个特权入口），而不是绕开它的
 * harness 后门——这样测试练到的是与生产完全相同的写入/持久化路径。
 * 生产默认 capabilities 仍是 confirmPairing 写入的空集，这个 helper 只是让测试
 * 不必自己搭一个尚不存在的授权 UI 就能验证已授权路径。
 */
export async function grantMailCapabilities(harness, capabilities) {
  return harness.api.setMailCapabilities(capabilities);
}

/**
 * 把 buildRequest 的产物序列化成真实 HTTP/1.1 报文文本。
 * `epochFieldValue` 用于精确控制 X-Thunderbird-Pairing-Epoch 冒号之后的原始字节
 * （含 OWS），以便测试真实 parser 对空白的处理。
 */
export function toWireText(request, options = {}) {
  const canonicalName = {
    "host": "Host", "authorization": "Authorization", "content-type": "Content-Type",
    "x-thunderbird-client": "X-Thunderbird-Client", "x-thunderbird-protocol": "X-Thunderbird-Protocol",
    "x-thunderbird-client-version": "X-Thunderbird-Client-Version", "x-request-id": "X-Request-Id",
    "x-request-timestamp": "X-Request-Timestamp", "x-request-nonce": "X-Request-Nonce",
    "x-content-sha256": "X-Content-SHA256", "x-thunderbird-pairing-epoch": "X-Thunderbird-Pairing-Epoch",
    "x-thunderbird-client-id": "X-Thunderbird-Client-Id", "x-request-signature": "X-Request-Signature",
  };
  const lines = [`${request.method} ${request.path} HTTP/1.1`];
  for (const [name, value] of request.headers) {
    if (name === "x-thunderbird-pairing-epoch" && options.epochFieldValue !== undefined) continue;
    lines.push(`${canonicalName[name] ?? name}:${options.noOws ? "" : " "}${value}`);
  }
  if (options.epochFieldValue !== undefined) lines.push(`X-Thunderbird-Pairing-Epoch:${options.epochFieldValue}`);
  if (options.omitEpoch) {
    const index = lines.findIndex((line) => line.toLowerCase().startsWith("x-thunderbird-pairing-epoch:"));
    if (index >= 0) lines.splice(index, 1);
  }
  lines.push(`Content-Length: ${Buffer.byteLength(request.bodyText)}`);
  return `${lines.join("\r\n")}\r\n\r\n${request.bodyText}`;
}

export function makeResponse() {
  const captured = { status: null, headers: new Map(), body: "", finished: false };
  return {
    captured,
    setStatusLine(_version, status) { captured.status = status; },
    setHeader(name, value) { captured.headers.set(name, value); },
    write(value) { captured.body += value; },
    finish() { captured.finished = true; },
    json() { return JSON.parse(captured.body); },
  };
}

/** 完整跑一次 preflight + dispatch，返回 {status, body} 或抛出的错误。 */
export async function handle(harness, request) {
  const response = makeResponse();
  try {
    await harness.preflight(request);
    await harness.dispatch(request, response);
    return { ok: true, status: response.captured.status ?? 200, body: response.captured.body ? response.json() : null, response };
  } catch (error) {
    // details（Task #43）：邮件 route dispatch 失败时，真实 api.js 已经在
    // reject()/errorWithStatus() 里把它挂到抛出的 error 对象上；这里原样
    // 透传，不做额外处理——夹具的职责是如实反映 api.js 内部真实抛出的错误
    // 形状，allowlist 校验本身发生在 api.js 内部（sanitizeMailErrorDetails），
    // 已经在这个 error.details 上生效过了。
    return { ok: false, status: error.status, code: error.code, message: error.message, details: error.details, response };
  }
}

export { canonicalizeRequest, signRequest };
