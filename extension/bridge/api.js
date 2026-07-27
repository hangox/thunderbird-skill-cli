"use strict";

const RESOURCE_NAME = "thunderbird-skill-bridge";
const PROTOCOL_VERSION = 1;
const DESCRIPTOR_VERSION = 2;
const EXTENSION_VERSION = "0.2.1";
const CLI_VERSION = "0.2.1";
const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_RECEIPT_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const REQUEST_DEADLINE_MS = 1_500;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_CONNECTIONS = 32;
const RESPONSE_CLOSE_GRACE_MS = 10;
const RESPONSE_DRAIN_GRACE_MS = 250;
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const PREF_PAIRING = "extensions.thunderbird-skill-bridge.pairing";
// pairingEpoch 必须与 pairing JSON 分开持久化：clearPairing 会删除 PREF_PAIRING，
// 而 epoch 必须在 revoke 与重启之间单调保持，绝不能被清对操作重置。
const PREF_PAIRING_EPOCH = "extensions.thunderbird-skill-bridge.pairingEpoch";
const PAIRING_EPOCH_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const PUBLIC_KEY_ALGORITHM = "Ed25519";
const ED25519_SPKI_BASE64_LENGTH = 60;
const ED25519_SPKI_DER_BYTES = 44;
const ED25519_SPKI_PREFIX_HEX = "302a300506032b6570032100";
const resProto = Cc["@mozilla.org/network/protocol;1?name=resource"].getService(Ci.nsISubstitutingProtocolHandler);
const hiddenWindow = Services.appShell.hiddenDOMWindow;
const webCrypto = hiddenWindow.crypto;
const textEncoder = new hiddenWindow.TextEncoder();
const textDecoder = new hiddenWindow.TextDecoder("utf-8", { fatal: true });
const decodeBase64 = hiddenWindow.atob.bind(hiddenWindow);

function randomHex(bytes) {
  const values = new Uint8Array(bytes);
  webCrypto.getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, "0")).join("");
}

function hashHex(value) {
  const data = textEncoder.encode(value);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  hash.init(hash.SHA256);
  hash.update(data, data.length);
  return Array.from(hash.finish(false), character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  const max = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

function errorWithStatus(status, message, code = "E_REJECTED") {
  return Object.assign(new Error(message), { status, code });
}

function isWouldBlock(error) {
  return error === Cr.NS_BASE_STREAM_WOULD_BLOCK || error?.result === Cr.NS_BASE_STREAM_WOULD_BLOCK;
}

function isStreamClosed(error) {
  return error === Cr.NS_BASE_STREAM_CLOSED || error?.result === Cr.NS_BASE_STREAM_CLOSED;
}

function readHeader(request, name) {
  return request.headers.get(name.toLowerCase()) || "";
}

function byteString(value) {
  const bytes = textEncoder.encode(value);
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 4096) output += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return output;
}

function writeFully(stream, value) {
  let offset = 0;
  while (offset < value.length) {
    const written = stream.write(value.slice(offset), value.length - offset);
    if (written <= 0) throw new Error("socket 响应写入失败");
    offset += written;
  }
}

function reasonPhrase(status) {
  return ({ 200: "OK", 201: "Created", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout", 409: "Conflict", 413: "Content Too Large", 426: "Upgrade Required", 431: "Request Header Fields Too Large", 500: "Internal Server Error", 501: "Not Implemented", 503: "Service Unavailable" })[status] || "Rejected";
}

function drainResponse(connection, output = connection.output) {
  if (connection.closed || !connection.responseBuffer) return;
  while (connection.responseOffset < connection.responseBuffer.length) {
    let written;
    try {
      const pending = connection.responseBuffer.slice(connection.responseOffset);
      written = output.write(pending, pending.length);
    } catch (error) {
      if (isWouldBlock(error)) {
        output.asyncWait(connection, 0, 0, Services.tm.mainThread);
        return;
      }
      connection.abort(error?.result || Cr.NS_ERROR_ABORT);
      return;
    }
    if (written <= 0) {
      output.asyncWait(connection, 0, 0, Services.tm.mainThread);
      return;
    }
    connection.responseOffset += written;
  }
  connection.scheduleResponseClose();
}

function createResponse(connection) {
  let status = 200;
  const headers = new Map();
  const chunks = [];
  return {
    setStatusLine(_version, value) { status = value; },
    setHeader(name, value) { headers.set(name, value); },
    write(value) { chunks.push(value); },
    finish() {
      if (connection.closed) return;
      const body = byteString(chunks.join(""));
      headers.set("Content-Length", String(body.length));
      headers.set("Connection", "close");
      let head = `HTTP/1.1 ${status} ${reasonPhrase(status)}\r\n`;
      for (const [name, value] of headers) head += `${name}: ${value}\r\n`;
      head += "\r\n";
      connection.sendResponse(head + body);
    },
  };
}

function writeJson(response, status, value) {
  response.setStatusLine("1.1", status, reasonPhrase(status));
  response.setHeader("Content-Type", "application/json; charset=utf-8", false);
  response.setHeader("Cache-Control", "no-store", false);
  response.write(JSON.stringify(value));
  response.finish();
}

function canonical(request) {
  return [request.method.toUpperCase(), request.path, request.host, request.protocol, request.requestId, request.timestamp, request.nonce, request.bodySha256, request.pairingEpoch].join("\n");
}

// publicKeyAlgorithm 是纯断言：它只用于确认对端声明的密钥类型与本实现唯一支持的
// Ed25519 一致，绝不用来选择算法分支，也不参与任何签名算法协商。
function isEd25519Spki(value) {
  if (typeof value !== "string" || value.length !== ED25519_SPKI_BASE64_LENGTH) return false;
  if (!/^[A-Za-z0-9+/]{59}=$/.test(value)) return false;
  let bytes;
  try { bytes = Uint8Array.from(decodeBase64(value), character => character.charCodeAt(0)); } catch { return false; }
  if (bytes.length !== ED25519_SPKI_DER_BYTES) return false;
  const prefix = Array.from(bytes.subarray(0, ED25519_SPKI_PREFIX_HEX.length / 2), byte => byte.toString(16).padStart(2, "0")).join("");
  return prefix === ED25519_SPKI_PREFIX_HEX;
}

function isPairingIdentityBody(value) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 3
    && Object.prototype.hasOwnProperty.call(value, "clientId")
    && Object.prototype.hasOwnProperty.call(value, "publicKeyAlgorithm")
    && Object.prototype.hasOwnProperty.call(value, "publicKeySpkiBase64")
    && typeof value.clientId === "string"
    && /^client_[A-Za-z0-9_-]{8,128}$/.test(value.clientId)
    && value.publicKeyAlgorithm === PUBLIC_KEY_ALGORITHM
    && isEd25519Spki(value.publicKeySpkiBase64);
}

async function verifySignature(request, pairing) {
  if (!pairing || request.clientId !== pairing.clientId || !request.signature) return false;
  if (pairing.publicKeyAlgorithm !== PUBLIC_KEY_ALGORITHM || !isEd25519Spki(pairing.publicKeySpkiBase64)) return false;
  try {
    const keyBytes = Uint8Array.from(decodeBase64(pairing.publicKeySpkiBase64), character => character.charCodeAt(0));
    const signature = Uint8Array.from(decodeBase64(request.signature), character => character.charCodeAt(0));
    const key = await webCrypto.subtle.importKey("spki", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    return webCrypto.subtle.verify("Ed25519", key, signature, textEncoder.encode(canonical(request)));
  } catch { return false; }
}

function loadPairing() {
  try {
    const value = JSON.parse(Services.prefs.getStringPref(PREF_PAIRING, ""));
    if (!value || typeof value.clientId !== "string") return null;
    // 持久记录缺失或不匹配 publicKeyAlgorithm 时一律失败关闭，绝不默认回填 Ed25519。
    if (value.publicKeyAlgorithm !== PUBLIC_KEY_ALGORITHM || !isEd25519Spki(value.publicKeySpkiBase64)) return null;
    return value;
  } catch { return null; }
}

function savePairing(value) {
  Services.prefs.setStringPref(PREF_PAIRING, JSON.stringify(value));
}

function clearPairing() {
  try { Services.prefs.clearUserPref(PREF_PAIRING); } catch {}
}

// 读取失败关闭：pref 缺失视为首次运行的 0；存在但不合法则抛错，绝不静默回退成较小的 epoch。
function loadPairingEpoch() {
  let raw = "";
  try { raw = Services.prefs.getStringPref(PREF_PAIRING_EPOCH, ""); } catch { raw = ""; }
  if (raw === "") return 0n;
  if (!PAIRING_EPOCH_PATTERN.test(raw)) throw new Error("pairingEpoch 持久值不合法");
  return BigInt(raw);
}

function savePairingEpoch(value) {
  Services.prefs.setStringPref(PREF_PAIRING_EPOCH, String(value));
}

function ensureDirectory(parent, name) {
  const directory = parent.clone();
  directory.append(name);
  if (!directory.exists()) directory.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  if (!directory.isDirectory() || directory.isSymlink()) throw new Error("运行目录不安全");
  try { directory.permissions = 0o700; } catch {}
  if (directory.permissions && (directory.permissions & 0o077) !== 0) throw new Error("运行目录权限不安全");
  return directory;
}

function descriptorFile(instanceId) {
  const root = ensureDirectory(Services.dirsvc.get("TmpD", Ci.nsIFile), "thunderbird-skill-cli");
  const instances = ensureDirectory(root, "instances");
  const file = instances.clone();
  file.append(`${instanceId}.json`);
  return file;
}

function writeAtomicDescriptor(file, descriptor) {
  if (file.exists() && file.isSymlink()) throw new Error("descriptor 路径不安全");
  const stream = Cc["@mozilla.org/network/safe-file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
  stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
  const bytes = byteString(JSON.stringify(descriptor));
  writeFully(stream, bytes);
  stream.flush();
  stream.QueryInterface(Ci.nsISafeOutputStream).finish();
  try { file.permissions = 0o600; } catch {}
  if (!file.exists() || file.isSymlink() || (file.permissions && (file.permissions & 0o177) !== 0)) throw new Error("descriptor 发布失败或权限不安全");
  return file.path;
}

function removeDescriptor(instanceId) {
  if (!instanceId) return;
  try {
    const file = descriptorFile(instanceId);
    if (file.exists() && !file.isSymlink()) file.remove(false);
  } catch {}
}

function descriptorWatchdogScript() {
  return [
    'parent="$1"',
    'descriptor="$2"',
    'instance="$3"',
    'while /bin/kill -0 "$parent" 2>/dev/null; do /bin/sleep 1; done',
    'current_instance=$(/usr/bin/plutil -extract instanceId raw -o - "$descriptor" 2>/dev/null) || exit 0',
    'if test "$current_instance" = "$instance"; then /bin/unlink "$descriptor"; fi',
  ].join("\n");
}

function startDescriptorWatchdog(file, parentPid, instanceId) {
  const executable = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  executable.initWithPath("/bin/sh");
  const process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
  process.init(executable);
  const script = descriptorWatchdogScript();
  const args = ["-c", script, "thunderbird-skill-descriptor-watchdog", String(parentPid), file.path, instanceId];
  process.run(false, args, args.length);
  return process;
}

function splitRequestHead(value) {
  const headerEnd = value.indexOf("\r\n\r\n");
  if (headerEnd < 0) {
    if (value.length > MAX_HEADER_BYTES) throw errorWithStatus(431, "请求 header 超过大小限制");
    return null;
  }
  if (headerEnd > MAX_HEADER_BYTES) throw errorWithStatus(431, "请求 header 超过大小限制");
  return { head: value.slice(0, headerEnd), rest: value.slice(headerEnd + 4) };
}

function parseRequestHead(value) {
  const lines = value.split("\r\n");
  const requestLine = lines.shift() || "";
  const match = /^(GET|POST) ([\x21-\x7e]+) HTTP\/1\.1$/.exec(requestLine);
  if (!match || !match[2].startsWith("/") || match[2].includes("#")) throw errorWithStatus(400, "请求行不合法");
  const headers = new Map();
  // rawHeaders 保留未经 trim 的原始 field value。通用 header 仍按 HTTP OWS 语义 trim（见 headers），
  // 只有要求唯一编码的 header（当前是 X-Thunderbird-Pairing-Epoch）才改用原始值判定。
  const rawHeaders = new Map();
  for (const line of lines) {
    const header = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):([^\r\n]*)$/.exec(line);
    if (!header) throw errorWithStatus(400, "请求 header 不合法");
    const name = header[1].toLowerCase();
    if (headers.has(name)) throw errorWithStatus(400, "不允许重复 header");
    headers.set(name, header[2].trim());
    rawHeaders.set(name, header[2]);
  }
  if (headers.has("transfer-encoding")) throw errorWithStatus(400, "不允许 Transfer-Encoding");
  const contentLengthText = headers.get("content-length");
  if (contentLengthText === undefined || !/^\d+$/.test(contentLengthText)) throw errorWithStatus(400, "Content-Length 不合法");
  const contentLength = Number(contentLengthText);
  if (!Number.isSafeInteger(contentLength) || contentLength > MAX_BODY_BYTES) throw errorWithStatus(413, "请求 body 超过大小限制");
  return { method: match[1], path: match[2], headers, rawHeaders, contentLength, bodyText: "", authenticated: null, pairingCandidate: null };
}

// X-Thunderbird-Pairing-Epoch 必须有唯一字节编码：只允许 field-value 前存在一个标准 OWS 分隔符，
// 值本身两侧不得再有任何空白。因此 " 7" / "7 " 这类写法在认证元数据关卡即失败关闭，
// 绝不会被 trim 成 "7" 后再进入 epoch 比较而误报成 E_PAIRING_CHANGED。
function readPairingEpochHeader(request) {
  const raw = request.rawHeaders?.get("x-thunderbird-pairing-epoch");
  if (typeof raw !== "string") return "";
  return raw.startsWith(" ") ? raw.slice(1) : raw;
}

function decodeRequestBody(value, contentLength) {
  if (value.length > contentLength) throw errorWithStatus(400, "不支持 HTTP pipelining");
  if (value.length < contentLength) return null;
  try {
    const bytes = Uint8Array.from(value, character => character.charCodeAt(0));
    return textDecoder.decode(bytes);
  } catch {
    throw errorWithStatus(400, "请求 body 不是 UTF-8");
  }
}

function nextReadSize(connection, available) {
  const limit = connection.request
    ? connection.request.contentLength - connection.buffer.length
    : MAX_HEADER_BYTES + 4 - connection.buffer.length;
  return Math.min(available, Math.max(1, limit + 1));
}

function ensureRequestActive(request) {
  if (request.isCancelled?.() || Date.now() >= request.deadlineAt) throw errorWithStatus(408, "请求超过总时限");
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// canonical 变更不 bump protocolVersion：改用 CLI/扩展版本兼容握手，让旧 CLI 在签名验证之前
// 就拿到明确的 E_VERSION_MISMATCH，而不是一个难以诊断的 401。
function isSupportedCliVersion(value) {
  const candidate = parseVersion(value);
  const min = parseVersion(CLI_VERSION);
  const max = parseVersion(CLI_VERSION);
  if (!candidate) return false;
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
    return 0;
  };
  return compare(candidate, min) >= 0 && compare(candidate, max) <= 0;
}

function createLoopbackServer(preflight, dispatch) {
  const socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
  const flags = Ci.nsIServerSocket.KeepWhenOffline | Ci.nsIServerSocket.LoopbackOnly;
  socket.initSpecialConnection(-1, flags, 8);
  const connections = new Set();

  function accept(_server, transport) {
    if (transport.host !== "127.0.0.1" || connections.size >= MAX_CONNECTIONS) {
      transport.close(Cr.NS_ERROR_ABORT);
      return;
    }
    const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
    const output = transport.openOutputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
    const connection = {
      QueryInterface: ChromeUtils.generateQI(["nsIInputStreamCallback", "nsIOutputStreamCallback"]),
      input,
      output,
      transport,
      buffer: "",
      request: null,
      closed: false,
      processing: false,
      timedOut: false,
      timeout: null,
      responseBuffer: null,
      responseOffset: 0,
      deadlineAt: Date.now() + REQUEST_DEADLINE_MS,
      abort(status = Cr.NS_ERROR_ABORT) {
        if (this.closed) return;
        this.closed = true;
        if (this.timeout) hiddenWindow.clearTimeout(this.timeout);
        try { this.input.asyncWait(null, 0, 0, null); } catch {}
        try { this.output.asyncWait(null, 0, 0, null); } catch {}
        try { this.input.close(); } catch {}
        try { this.output.close(); } catch {}
        try { this.transport.close(status); } catch {}
        connections.delete(this);
      },
      scheduleResponseClose() {
        if (this.closed) return;
        if (this.timeout) hiddenWindow.clearTimeout(this.timeout);
        this.timeout = hiddenWindow.setTimeout(() => this.finishResponse(), RESPONSE_CLOSE_GRACE_MS);
      },
      finishResponse() {
        if (this.closed) return;
        this.closed = true;
        if (this.timeout) hiddenWindow.clearTimeout(this.timeout);
        try { this.input.asyncWait(null, 0, 0, null); } catch {}
        try { this.output.asyncWait(null, 0, 0, null); } catch {}
        try { this.input.close(); } catch {}
        try { this.output.close(); } catch {}
        connections.delete(this);
      },
      sendResponse(value) {
        if (this.closed || this.responseBuffer) return;
        this.processing = true;
        this.responseBuffer = value;
        this.responseOffset = 0;
        try { this.output.asyncWait(this, 0, 0, Services.tm.mainThread); }
        catch (error) { this.abort(error?.result || Cr.NS_ERROR_ABORT); }
      },
      reject(status, message, code = "E_REJECTED") {
        if (this.closed || this.responseBuffer) return;
        writeJson(createResponse(this), status, { error: { code, message } });
      },
      async consume() {
        if (this.closed || this.processing) return;
        if (!this.request) {
          let split;
          try { split = splitRequestHead(this.buffer); }
          catch (error) { return this.reject(error.status || 400, error.message || "请求 header 不合法", error.code); }
          if (!split) return this.arm();
          this.buffer = split.rest;
          try { this.request = parseRequestHead(split.head); }
          catch (error) { return this.reject(error.status || 400, error.message || "请求 header 不合法", error.code); }
          this.request.deadlineAt = this.deadlineAt;
          this.request.isCancelled = () => this.closed || this.timedOut;
          this.processing = true;
          try {
            await preflight(this.request);
            ensureRequestActive(this.request);
          } catch (error) {
            this.processing = false;
            return this.reject(error.status || 400, error.message || "请求被拒绝", error.code);
          }
          this.processing = false;
        }
        let bodyText;
        try { bodyText = decodeRequestBody(this.buffer, this.request.contentLength); }
        catch (error) { return this.reject(error.status || 400, error.message || "请求 body 不合法", error.code); }
        if (bodyText === null) return this.arm();
        this.request.bodyText = bodyText;
        this.processing = true;
        try {
          ensureRequestActive(this.request);
          await dispatch(this.request, createResponse(this));
        } catch (error) {
          if (!this.closed) this.reject(error.status || 400, error.message || "请求被拒绝", error.code);
        }
      },
      onInputStreamReady(stream) {
        if (this.closed || this.processing) return;
        try {
          const available = stream.available();
          if (available <= 0) return this.arm();
          const readable = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
          readable.init(stream);
          this.buffer += readable.read(nextReadSize(this, available));
          void this.consume();
        } catch (error) {
          if (isStreamClosed(error) && (this.request || this.buffer.length > 0)) {
            void this.consume();
            return;
          }
          this.abort(error?.result || Cr.NS_ERROR_ABORT);
        }
      },
      onOutputStreamReady(output) {
        drainResponse(this, output);
      },
      arm() {
        if (!this.closed && !this.responseBuffer) this.input.asyncWait(this, 0, 0, Services.tm.mainThread);
      },
    };
    connections.add(connection);
    connection.timeout = hiddenWindow.setTimeout(() => {
      if (connection.closed) return;
      connection.timedOut = true;
      connection.reject(408, "请求超过总时限");
      if (!connection.closed) connection.timeout = hiddenWindow.setTimeout(() => connection.abort(), RESPONSE_DRAIN_GRACE_MS);
    }, REQUEST_DEADLINE_MS);
    connection.arm();
  }

  const listener = {
    QueryInterface: ChromeUtils.generateQI(["nsIServerSocketListener"]),
    onSocketAccepted: accept,
    onStopListening() {},
  };
  socket.asyncListen(listener);
  return {
    port: socket.port,
    stop(callback) {
      try { socket.close(); } catch {}
      for (const connection of [...connections]) connection.abort();
      callback?.();
    },
  };
}

// ---------------------------------------------------------------------------
// 邮件 route 通用管线：反原型污染的 body 守卫、opaque ref 绑定表、静态
// route registry，以及把已认证请求转发给 background 执行的 Experiment→
// background operation 通道（onOperation 事件 + respondToOperation/
// failOperation 两个回调函数）。这是 extension/src/schema.ts、
// extension/src/refs.ts、src/contracts/routes.ts 三份纯 TS 参考实现在
// Experiment 特权作用域下的运行时镜像——这里无法 `import` 编译产物，只能像
// 本文件既有的 canonical()/isEd25519Spki() 那样手动保持同步，由测试兜底
// 一致性；listMailRoutes() 额外给 background 提供了一个运行时自检点。
//
// 关键边界：本文件（api.js）自身不实现任何邮件业务语义，不调用任何邮件相关
// 的 XPCOM 组件——认证/capability/body 上限/反原型污染校验通过后就把请求
// 原样转发给 background，由 background 用标准 MailExtension API 执行业务
// 逻辑。本轮全部 route 在 background 侧仍标记 "not-implemented"，
// 因此转发链路真实可用，但目前对任意邮件 route 请求都会统一收到
// 501 E_NOT_IMPLEMENTED。范围裁决（team-lead，2026-07-27）：v0.3.0 不实现
// 永久删除、watch、calendar，这里不冻结它们的 route。
// ---------------------------------------------------------------------------

const MAIL_DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 递归拒绝危险键，是进入任何业务逻辑前的最低限度防原型污染防线；具体字段级
// 的未知字段/长度/枚举上限校验由各 route 实现 PR 用 extension/src/schema.ts
// 同款 shape 补齐，这里不预判尚未冻结的业务 schema。
function assertNoDangerousKeys(value) {
  if (Array.isArray(value)) { value.forEach((item) => assertNoDangerousKeys(item)); return; }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (MAIL_DANGEROUS_KEYS.has(key)) throw errorWithStatus(400, "请求 body 包含禁止的键名", "E_VALIDATION");
    assertNoDangerousKeys(value[key]);
  }
}

// 单个 ref 允许的最长存活时间：即使调用方传入更大的 ttlMs 也会被拒绝，不
// 静默接受一个长期存活、扩大暴露窗口的 ref。与 extension/src/refs.ts 的
// MAX_REF_TTL_MS 保持一致。
const MAX_REF_TTL_MS = 30 * 60 * 1000;

// issue() 因配额耗尽而拒绝时抛出的显式类型错误，调用方可据此与其他内部错误
// 区分，映射为稳定的错误语义而不是笼统的 500。kind === "*" 表示命中的是跨
// kind 的全局在途上限，不是某个具体 kind 的上限。与 extension/src/refs.ts 的
// RefStoreCapacityError 是同一份设计的镜像。
class RefStoreCapacityError extends Error {
  constructor(kind, limit) {
    super(kind === "*" ? `ref store 已达到全局在途上限（${limit}），拒绝签发新 ref` : `ref kind ${kind} 已达到在途上限（${limit}），拒绝签发新 ref`);
    this.name = "RefStoreCapacityError";
    this.kind = kind;
    this.limit = limit;
  }
}

// 与 extension/src/refs.ts 的 RefStore 是同一份设计的运行时镜像：CLI 是一次性
// 进程，扩展实例在 Thunderbird 会话内长期存活，因此用内存绑定表（token →
// {kind, clientId, pairingEpoch, payload, 过期时间}）而非自描述签名令牌；
// resolve 要求 clientId 与 pairingEpoch 精确匹配，任一不符一律视为不存在。
function createRefStore(maxEntriesPerKind = 4000, maxTotalEntries = 20000) {
  const entries = new Map();
  const countByKind = new Map();
  function remove(token) {
    const entry = entries.get(token);
    if (!entry) return;
    entries.delete(token);
    const current = countByKind.get(entry.kind) ?? 0;
    if (current > 0) countByKind.set(entry.kind, current - 1);
  }
  return {
    // 过期回收：dispatch 在每个已认证请求上都会调用一次（见
    // validateAuthenticatedRequest 里与 nonce 清理同一节奏的调用），因此即使
    // 某个 kind 长时间没有新的 issue()，过期条目也会随请求流量被及时释放。
    prune(nowMs = Date.now()) {
      for (const [token, entry] of entries) if (entry.expiresAt <= nowMs) remove(token);
    },
    issue(kind, clientId, pairingEpoch, payload, ttlMs) {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs 必须是正有限数");
      if (ttlMs > MAX_REF_TTL_MS) throw new RangeError(`ttlMs 不得超过 MAX_REF_TTL_MS（${MAX_REF_TTL_MS}ms）`);
      this.prune();
      // 全局上限是压力回收的第二道防线：即使每个 kind 各自都没超限，合计条目
      // 数也不得无界增长。
      if (entries.size >= maxTotalEntries) throw new RefStoreCapacityError("*", maxTotalEntries);
      const current = countByKind.get(kind) ?? 0;
      if (current >= maxEntriesPerKind) throw new RefStoreCapacityError(kind, maxEntriesPerKind);
      const nowMs = Date.now();
      let token;
      do { token = `${kind}_${randomHex(24)}`; } while (entries.has(token));
      entries.set(token, { kind, clientId, pairingEpoch, payload, issuedAt: nowMs, expiresAt: nowMs + ttlMs });
      countByKind.set(kind, current + 1);
      return token;
    },
    // 解析失败（不存在/kind 不符/client 不符/epoch 不符/已过期）一律返回 undefined，
    // 不区分具体原因；调用方必须统一映射为 E_NOT_FOUND，不得泄漏对象是否存在。
    resolve(token, expectedKind, context) {
      const entry = entries.get(token);
      if (!entry || entry.kind !== expectedKind || entry.clientId !== context.clientId || entry.pairingEpoch !== context.pairingEpoch) return undefined;
      if (entry.expiresAt <= context.nowMs) { remove(token); return undefined; }
      return entry.payload;
    },
    consume(token) { remove(token); },
    revokeAllForClient(clientId) {
      for (const [token, entry] of entries) if (entry.clientId === clientId) remove(token);
    },
    clear() { entries.clear(); countByKind.clear(); },
    get size() { return entries.size; },
  };
}

// draft send 的 prepare/confirm 外发确认走 RefStore 的 "confirm" kind
// （revision/收件人/主题/附件 digest 绑定）。

const MAIL_ROUTE_PREFIX = "/v1/mail/";

// 与 src/contracts/routes.ts 的 MAIL_ROUTES 逐条对应（method 固定 POST）；
// 修改任一处的 id/path/capability/maxRequestBodyBytes 都必须同步另一处。
const MAIL_ROUTES = [
  { id: "accounts.list", path: `${MAIL_ROUTE_PREFIX}accounts.list`, capability: "mail.read.v1", maxRequestBodyBytes: 1024 },
  { id: "folders.list", path: `${MAIL_ROUTE_PREFIX}folders.list`, capability: "mail.read.v1", maxRequestBodyBytes: 2048 },
  { id: "messages.search", path: `${MAIL_ROUTE_PREFIX}messages.search`, capability: "mail.read.v1", maxRequestBodyBytes: 8192 },
  { id: "messages.recent", path: `${MAIL_ROUTE_PREFIX}messages.recent`, capability: "mail.read.v1", maxRequestBodyBytes: 2048 },
  { id: "messages.get", path: `${MAIL_ROUTE_PREFIX}messages.get`, capability: "mail.read.v1", maxRequestBodyBytes: 2048 },
  { id: "messages.open", path: `${MAIL_ROUTE_PREFIX}messages.open`, capability: "mail.read.v1", maxRequestBodyBytes: 1024 },
  { id: "messages.mark", path: `${MAIL_ROUTE_PREFIX}messages.mark`, capability: "mail.reversible.v1", maxRequestBodyBytes: 8192 },
  { id: "messages.move", path: `${MAIL_ROUTE_PREFIX}messages.move`, capability: "mail.reversible.v1", maxRequestBodyBytes: 8192 },
  { id: "messages.trash", path: `${MAIL_ROUTE_PREFIX}messages.trash`, capability: "mail.reversible.v1", maxRequestBodyBytes: 8192 },
  // message delete（永久删除）本轮不实现，无对应 route（team-lead 范围裁决 2026-07-27）。
  { id: "attachments.list", path: `${MAIL_ROUTE_PREFIX}attachments.list`, capability: "mail.read.v1", maxRequestBodyBytes: 1024 },
  { id: "attachments.save", path: `${MAIL_ROUTE_PREFIX}attachments.save`, capability: "mail.reversible.v1", maxRequestBodyBytes: 4096 },
  { id: "drafts.create", path: `${MAIL_ROUTE_PREFIX}drafts.create`, capability: "draft.write.v1", maxRequestBodyBytes: 8192 },
  { id: "drafts.update", path: `${MAIL_ROUTE_PREFIX}drafts.update`, capability: "draft.write.v1", maxRequestBodyBytes: 8192 },
  { id: "drafts.open", path: `${MAIL_ROUTE_PREFIX}drafts.open`, capability: "draft.write.v1", maxRequestBodyBytes: 1024 },
  { id: "drafts.send.prepare", path: `${MAIL_ROUTE_PREFIX}drafts.send.prepare`, capability: "mail.send-confirmed.v1", maxRequestBodyBytes: 2048 },
  { id: "drafts.send.confirm", path: `${MAIL_ROUTE_PREFIX}drafts.send.confirm`, capability: "mail.send-confirmed.v1", maxRequestBodyBytes: 2048 },
  { id: "operations.get", path: `${MAIL_ROUTE_PREFIX}operations.get`, capability: "mail.read.v1", maxRequestBodyBytes: 1024 },
  // watch（bounded JSONL 事件流）本轮不实现，无对应 route（team-lead 范围裁决 2026-07-27）。
];

// 与 src/contracts/routes.ts 的 MAIL_CAPABILITIES 逐条对应；setMailCapabilities
// 用它拒绝任何未知字符串或没有对应 route 的死能力标识。
const KNOWN_MAIL_CAPABILITIES = new Set(["mail.read.v1", "mail.reversible.v1", "draft.write.v1", "mail.send-confirmed.v1"]);

function findMailRoute(method, path) {
  if (method !== "POST") return undefined;
  return MAIL_ROUTES.find((route) => route.path === path);
}

// background 用 failOperation 报告的错误码只信任这个已知集合，其余一律降级
// 为 E_INTERNAL/500，防止业务侧的任意字符串直接冒充协议错误码进入 HTTP 响应。
const MAIL_ROUTE_ERROR_STATUS = {
  E_NOT_IMPLEMENTED: 501,
  E_NOT_FOUND: 404,
  E_POLICY_DENIED: 403,
  E_CONFIRMATION_REQUIRED: 409,
  E_VALIDATION: 400,
  E_TIMEOUT: 408,
  E_THUNDERBIRD_OFFLINE: 503,
  E_INTERNAL: 500,
};

// 只在缺少 ExtensionCommon.EventManager 的环境（当前测试夹具）下生效的等价
// 实现：register(fire) 在监听者数量 0→1 时调用一次并返回 unregister，
// 语义与真实 EventManager 完全一致，因此 createOperationChannel 的其余逻辑
// 不需要区分两条分支。真实 Thunderbird 环境优先使用 ExtensionCommon.EventManager，
// 这样跨进程的 background↔特权层通信走 WebExtension 既定的结构化克隆通道。
function createEventManager(context, name, register) {
  if (typeof ExtensionCommon.EventManager === "function") {
    return new ExtensionCommon.EventManager({ context, name, register }).api();
  }
  const listeners = new Set();
  let unregister = null;
  const fire = {
    async(...args) { for (const listener of listeners) listener(...args); },
    sync(...args) { for (const listener of listeners) listener(...args); },
  };
  return {
    addListener(listener) {
      listeners.add(listener);
      if (listeners.size === 1) unregister = register(fire);
    },
    removeListener(listener) {
      listeners.delete(listener);
      if (listeners.size === 0 && unregister) { unregister(); unregister = null; }
    },
    hasListener(listener) { return listeners.has(listener); },
  };
}

// api.js 本身不实现任何邮件业务语义、不调用任何邮件相关的 XPCOM 组件：
// 认证/capability/body 上限/反原型污染校验通过后，把请求经
// onOperation 事件转发给 background；background 用标准
// MailExtension API 执行真正的业务逻辑，再调用 respondToOperation /
// failOperation 之一唤醒这里挂起的 Promise。这个文件只负责转发、超时与
// 错误码翻译。
function createOperationChannel(context) {
  const pending = new Map(); // token -> { resolve, reject, timer }
  let fireEvent = null;
  const event = createEventManager(context, "thunderbirdSkillBridge.onOperation", (fire) => {
    fireEvent = fire;
    return () => { fireEvent = null; };
  });
  function settle(token, run) {
    const entry = pending.get(token);
    if (!entry) return false;
    pending.delete(token);
    hiddenWindow.clearTimeout(entry.timer);
    run(entry);
    return true;
  }
  return {
    event,
    hasListener: () => fireEvent !== null,
    dispatch(token, routeId, capability, bodyJson, deadlineAt) {
      return new Promise((resolve, reject) => {
        if (!fireEvent) { reject(errorWithStatus(503, "background 尚未就绪，无法处理邮件能力请求", "E_THUNDERBIRD_OFFLINE")); return; }
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) { reject(errorWithStatus(408, "请求超过总时限", "E_TIMEOUT")); return; }
        const timer = hiddenWindow.setTimeout(() => {
          settle(token, (entry) => entry.reject(errorWithStatus(408, "background 未在时限内响应该邮件能力", "E_TIMEOUT")));
        }, remaining);
        pending.set(token, { resolve, reject, timer });
        try {
          fireEvent.async(token, routeId, capability, bodyJson);
        } catch {
          settle(token, (entry) => entry.reject(errorWithStatus(500, "邮件 route 转发失败", "E_INTERNAL")));
        }
      });
    },
    respond(token, resultJson) {
      return settle(token, (entry) => {
        let value;
        try { value = JSON.parse(resultJson); }
        catch { entry.reject(errorWithStatus(500, "background 响应不是有效 JSON", "E_INTERNAL")); return; }
        entry.resolve(value);
      });
    },
    fail(token, errorCode, errorMessage) {
      return settle(token, (entry) => {
        const status = Object.hasOwn(MAIL_ROUTE_ERROR_STATUS, errorCode) ? MAIL_ROUTE_ERROR_STATUS[errorCode] : 500;
        const code = Object.hasOwn(MAIL_ROUTE_ERROR_STATUS, errorCode) ? errorCode : "E_INTERNAL";
        entry.reject(errorWithStatus(status, typeof errorMessage === "string" && errorMessage ? errorMessage : "该邮件能力处理失败", code));
      });
    },
    clear(message) {
      for (const token of [...pending.keys()]) settle(token, (entry) => entry.reject(errorWithStatus(503, message || "服务已停止", "E_THUNDERBIRD_OFFLINE")));
    },
  };
}

function stateView(state) {
  return {
    serviceStarted: Boolean(state.server),
    port: state.port,
    descriptorPath: state.descriptorPath,
    instanceId: state.instanceId,
    profileId: state.profileId,
    pairingState: state.pairingState,
    pairingEpoch: String(state.pairingEpoch),
    clientId: state.pairing?.clientId ?? null,
    pendingIntentId: state.pending?.intentId ?? null,
    pendingCode: state.pending?.code ?? null,
    pendingClientId: state.pending?.clientId ?? null,
    pendingExpiresAt: state.pending?.expiresAt ?? null,
    error: state.error,
  };
}

var thunderbirdSkillBridge = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    resProto.setSubstitutionWithFlags(RESOURCE_NAME, context.extension.rootURI, resProto.ALLOW_CONTENT_ACCESS);
    const storedPairing = loadPairing();
    const state = globalThis.__tbSkillState ??= {
      pairingEpoch: 0n,
      server: null,
      port: null,
      descriptorPath: null,
      instanceId: null,
      profileId: null,
      sessionToken: null,
      startedAt: null,
      expiresAt: null,
      pairing: storedPairing,
      pairingState: storedPairing ? "paired" : "unpaired",
      pending: null,
      receipts: new Map(),
      nonces: new Map(),
      refStore: createRefStore(),
      operationChannel: createOperationChannel(context),
      error: null,
      startPromise: null,
      expiryTimer: null,
      shutdownObserver: null,
      descriptorWatchdog: null,
    };

    function stopService(reason) {
      if (state.expiryTimer) {
        hiddenWindow.clearTimeout(state.expiryTimer);
        state.expiryTimer = null;
      }
      const server = state.server;
      state.server = null;
      state.sessionToken = null;
      state.refStore.clear();
      state.operationChannel.clear(reason ?? "本地会话已停止");
      removeDescriptor(state.instanceId);
      state.descriptorPath = null;
      state.error = reason ?? state.error;
      if (server) try { server.stop(() => {}); } catch {}
    }

    function ensureSessionActive() {
      if (!state.expiresAt || Date.parse(state.expiresAt) <= Date.now()) {
        stopService("本地会话已过期");
        throw errorWithStatus(401, "本地会话已过期");
      }
    }

    function pruneReceipts(now = Date.now()) {
      for (const [intentId, receipt] of state.receipts) if (Date.parse(receipt.receiptExpiresAt) <= now) state.receipts.delete(intentId);
    }

    function refreshDescriptor() {
      state.descriptorPath = writeAtomicDescriptor(descriptorFile(state.instanceId), {
        descriptorVersion: DESCRIPTOR_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        instanceId: state.instanceId,
        profileId: state.profileId,
        profileLabel: "Isolated Thunderbird Profile",
        pid: Services.appinfo.processID,
        port: state.port,
        sessionToken: state.sessionToken,
        extensionVersion: EXTENSION_VERSION,
        pairingEpoch: String(state.pairingEpoch),
        startedAt: state.startedAt,
        expiresAt: state.expiresAt,
      });
    }

    // 当前 epoch 的唯一真值来源；请求处理链路全程只与它比较。
    function currentEpoch() {
      return String(state.pairingEpoch);
    }

    // 每个 await 之后、每次副作用之前、以及写成功响应之前都必须调用：
    // 只要 revoke 在途中推进了 epoch，就立刻以 409 E_PAIRING_CHANGED 中止，不产生任何副作用。
    function ensureEpochUnchanged(req) {
      ensureRequestActive(req);
      if (req.pairingEpoch !== currentEpoch()) throw errorWithStatus(409, "配对代已在请求处理过程中变更", "E_PAIRING_CHANGED");
    }

    async function validateAuthenticatedRequest(req, options = {}) {
      ensureSessionActive();
      const authorization = readHeader(req, "Authorization");
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      if (!/^[a-f0-9]{64}$/.test(token) || !constantTimeEqual(token, state.sessionToken)) throw errorWithStatus(401, "认证失败");
      const host = readHeader(req, "Host");
      const origin = readHeader(req, "Origin");
      if (host !== `127.0.0.1:${state.port}` || origin) throw errorWithStatus(403, "请求被拒绝");
      const protocol = readHeader(req, "X-Thunderbird-Protocol");
      const requestId = readHeader(req, "X-Request-Id");
      const timestamp = readHeader(req, "X-Request-Timestamp");
      const nonce = readHeader(req, "X-Request-Nonce");
      const bodySha256 = readHeader(req, "X-Content-SHA256");
      const clientId = readHeader(req, "X-Thunderbird-Client-Id");
      const signature = readHeader(req, "X-Request-Signature");
      const pairingEpoch = readPairingEpochHeader(req);
      const clientVersion = readHeader(req, "X-Thunderbird-Client-Version");
      const now = Date.now();
      const timestampMs = Number(timestamp);
      // 版本握手必须先于任何“新增认证元数据”的解析与校验。旧版 CLI 根本不会发送
      // X-Thunderbird-Pairing-Epoch，若先校验 epoch，它只会得到难以诊断的 401；
      // 先做版本判定才能给出精确的 426 E_VERSION_MISMATCH。
      // 该判定只使用静态兼容区间，不读取任何业务状态，也永远不会进入 dispatch。
      if (!isSupportedCliVersion(clientVersion)) throw errorWithStatus(426, "CLI 与扩展版本不兼容", "E_VERSION_MISMATCH");
      // pairingEpoch 只接受严格十进制字面量：缺失、空白、前导零、正负号、0x/1e 记法、
      // 小数与超长值全部在此失败关闭；绝不使用 Number/parseInt 之类的宽松解析。
      if (protocol !== "1" || !/^cli_[0-9a-f-]{36}$/.test(requestId) || !/^[a-f0-9]{32}$/.test(nonce) || !Number.isSafeInteger(timestampMs) || Math.abs(now - timestampMs) > MAX_CLOCK_SKEW_MS || !/^[a-f0-9]{64}$/.test(bodySha256) || !PAIRING_EPOCH_PATTERN.test(pairingEpoch)) throw errorWithStatus(401, "请求认证元数据无效");
      // 以原始 header 字符串与当前 epoch 的字符串形式直接比较。
      if (pairingEpoch !== currentEpoch()) throw errorWithStatus(409, "配对代已变更", "E_PAIRING_CHANGED");
      for (const [value, expiresAt] of state.nonces) if (expiresAt < now) state.nonces.delete(value);
      if (state.nonces.has(nonce)) throw errorWithStatus(409, "请求已重放", "E_REPLAY");
      state.nonces.set(nonce, timestampMs + MAX_CLOCK_SKEW_MS);
      // opaque ref 的过期回收与 nonce 用同一节奏：搭在每个已认证请求上，
      // 不依赖某个 kind 恰好被 issue() 才清理。
      state.refStore.prune(now);
      const securityRequest = { method: req.method, path: req.path, host, protocol, requestId, timestamp, nonce, bodySha256, pairingEpoch, clientId, signature };
      if (options.requireSignature && !(await verifySignature(securityRequest, options.pairing || state.pairing))) throw errorWithStatus(401, "client 签名认证失败");
      // 验签本身是异步的：验签之后立刻复检 epoch，避免 await 期间 revoke 让旧签名仍被接受。
      req.pairingEpoch = pairingEpoch;
      ensureEpochUnchanged(req);
      return { securityRequest, bodySha256, pairingEpoch };
    }

    function requireEmptyJsonRequest(req, authenticated) {
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(readHeader(req, "Content-Type").trim()) || req.contentLength !== 0 || authenticated.bodySha256 !== EMPTY_BODY_SHA256) throw errorWithStatus(400, "请求格式不允许");
    }

    async function preflight(req) {
      if (req.path === "/v1/status") {
        req.authenticated = await validateAuthenticatedRequest(req, { requireSignature: Boolean(state.pairing) });
        if (req.method !== "GET") throw errorWithStatus(400, "请求 method 不允许");
        requireEmptyJsonRequest(req, req.authenticated);
        return;
      }
      if (req.method === "POST" && req.path === "/v1/pairing/intents") {
        req.authenticated = await validateAuthenticatedRequest(req, { requireSignature: Boolean(state.pairing) });
        if (state.pairing) throw errorWithStatus(409, "已配对状态必须先显式撤销现有 client", "E_ALREADY_PAIRED");
        // pending 冲突判定需要 body 里的 clientId，因此推迟到 dispatch；preflight 不再在此拒绝。
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(readHeader(req, "Content-Type").trim())) throw errorWithStatus(400, "请求 Content-Type 不合法");
        if (req.contentLength < 2) throw errorWithStatus(400, "请求 body 大小不合法");
        return;
      }
      const match = /^\/v1\/pairing\/intents\/(intent_[a-f0-9]{32})$/.exec(req.path);
      if (req.method === "GET" && match) {
        const basic = await validateAuthenticatedRequest(req, { requireSignature: false });
        pruneReceipts();
        const intentId = match[1];
        const live = state.pending?.intentId === intentId ? state.pending : state.receipts.get(intentId);
        if (!live) throw errorWithStatus(404, "配对请求不存在");
        // 快照：dispatch 只使用这份不可变副本，绝不重新读取可能已被 revoke 清空的 state.pending。
        const candidate = Object.freeze({
          intentId: live.intentId,
          clientId: live.clientId,
          publicKeyAlgorithm: live.publicKeyAlgorithm,
          publicKeySpkiBase64: live.publicKeySpkiBase64,
          expiresAt: live.expiresAt,
          pairingState: live.pairingState ?? null,
          isReceipt: Boolean(live.pairingState),
        });
        if (!(await verifySignature(basic.securityRequest, candidate))) throw errorWithStatus(401, "client 签名认证失败");
        ensureEpochUnchanged(req);
        requireEmptyJsonRequest(req, basic);
        req.authenticated = basic;
        req.pairingCandidate = candidate;
        return;
      }
      // 全部邮件 route：无论是否已配对都强制要求签名（requireSignature: true）。
      // 未配对时 state.pairing 为 null，verifySignature(request, null) 恒为
      // false，因此自然落到 401，实现"未配对失败关闭"，不需要额外分支。
      const mailRoute = findMailRoute(req.method, req.path);
      if (mailRoute) {
        req.authenticated = await validateAuthenticatedRequest(req, { requireSignature: true });
        // capability 只看配对时授予的静态集合，绝不接受请求体/请求头自称的能力或风险等级。
        const granted = state.pairing?.capabilities ?? [];
        if (!granted.includes(mailRoute.capability)) throw errorWithStatus(403, "当前配对未获授予该能力", "E_POLICY_DENIED");
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(readHeader(req, "Content-Type").trim())) throw errorWithStatus(400, "请求 Content-Type 不合法");
        if (req.contentLength > mailRoute.maxRequestBodyBytes) throw errorWithStatus(413, "请求 body 超过该 route 的硬上限");
        req.mailRoute = mailRoute;
        return;
      }
      await validateAuthenticatedRequest(req, { requireSignature: Boolean(state.pairing) });
      throw errorWithStatus(400, "route 不允许");
    }

    function readJsonBody(req) {
      if (hashHex(req.bodyText) !== readHeader(req, "X-Content-SHA256")) throw errorWithStatus(401, "请求 body 摘要不匹配");
      try { return JSON.parse(req.bodyText); } catch { throw errorWithStatus(400, "请求 body 不是有效 JSON"); }
    }

    async function dispatch(req, res) {
      if (req.method === "GET" && req.path === "/v1/status") {
        ensureEpochUnchanged(req);
        writeJson(res, 200, {
          protocolVersion: PROTOCOL_VERSION,
          minCliVersion: CLI_VERSION,
          maxCliVersion: CLI_VERSION,
          extensionVersion: EXTENSION_VERSION,
          instanceId: state.instanceId,
          profileId: state.profileId,
          // 账号/能力授权 UI 尚未实现：目前恒为配对记录里的静态 capabilities
          // （confirmPairing 写入 []），不会凭空出现任何邮件 capability。
          capabilities: state.pairing?.capabilities ?? [],
          pairingState: state.pairingState,
          pairingEpoch: currentEpoch(),
          authorizedAccountRefs: [],
        });
        return;
      }
      if (req.method === "POST" && req.path === "/v1/pairing/intents") {
        const body = readJsonBody(req);
        // body 必须恰好是 {clientId, publicKeyAlgorithm, publicKeySpkiBase64} 三键：
        // 缺字段、多出第四键、算法值大小写不符或非 Ed25519 SPKI 一律 400。
        if (!isPairingIdentityBody(body)) throw errorWithStatus(400, "配对身份格式不合法");
        const candidate = { clientId: body.clientId, publicKeyAlgorithm: body.publicKeyAlgorithm, publicKeySpkiBase64: body.publicKeySpkiBase64 };
        if (!(await verifySignature(req.authenticated.securityRequest, candidate))) throw errorWithStatus(401, "client 签名认证失败");
        ensureEpochUnchanged(req);
        // await 之后重新确认配对状态，避免在途中被确认为 paired。
        if (state.pairing) throw errorWithStatus(409, "已配对状态必须先显式撤销现有 client", "E_ALREADY_PAIRED");
        // S5：同一 clientId 且候选新公钥已验签通过时，允许替换在途 pending 并换发新 intentId 与挑战码；
        // 不同 clientId 仍然是硬冲突。验签发生在此判定之前，因此替换路径不会削弱任何认证要求。
        const pending = state.pending;
        if (pending && Date.parse(pending.expiresAt) > Date.now() && pending.clientId !== candidate.clientId) {
          throw errorWithStatus(409, "已有待确认配对请求", "E_PAIRING_PENDING");
        }
        state.pending = {
          intentId: `intent_${randomHex(16)}`,
          code: String(Math.floor(webCrypto.getRandomValues(new Uint32Array(1))[0] % 1000000)).padStart(6, "0"),
          clientId: candidate.clientId,
          publicKeyAlgorithm: candidate.publicKeyAlgorithm,
          publicKeySpkiBase64: candidate.publicKeySpkiBase64,
          expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
        };
        state.pairingState = "pairing";
        refreshDescriptor();
        ensureEpochUnchanged(req);
        writeJson(res, 201, { intentId: state.pending.intentId, challengeCode: state.pending.code, clientId: state.pending.clientId, expiresAt: state.pending.expiresAt, pairingState: "pairing" });
        return;
      }
      const match = /^\/v1\/pairing\/intents\/(intent_[a-f0-9]{32})$/.exec(req.path);
      if (req.method === "GET" && match) {
        const intentId = match[1];
        // 只使用 preflight 抓取的快照，绝不重新读取可能已被 revoke 清空的 state.pending / receipts。
        const candidate = req.pairingCandidate;
        if (!candidate || candidate.intentId !== intentId) throw errorWithStatus(404, "配对请求不存在");
        ensureEpochUnchanged(req);
        if (!candidate.isReceipt && Date.parse(candidate.expiresAt) <= Date.now()) {
          if (state.pending?.intentId === intentId) {
            state.pending = null;
            state.pairingState = state.pairing ? "paired" : "unpaired";
          }
          ensureEpochUnchanged(req);
          writeJson(res, 200, { intentId, pairingState: "expired", clientId: candidate.clientId, expiresAt: candidate.expiresAt });
          return;
        }
        writeJson(res, 200, { intentId, pairingState: candidate.isReceipt ? candidate.pairingState : "pairing", clientId: candidate.clientId, expiresAt: candidate.expiresAt });
        return;
      }
      if (req.mailRoute) {
        // preflight 到这里之间也可能发生 revoke：签名验证已通过不代表 epoch 仍然当前。
        ensureEpochUnchanged(req);
        const body = readJsonBody(req);
        assertNoDangerousKeys(body);
        ensureEpochUnchanged(req);
        // api.js 到此为止：不解释任何邮件业务语义，只把已认证/已过 capability
        // 门禁/已过反原型污染校验的请求转发给 background，等待其经
        // respondToOperation/failOperation 之一唤醒。
        const token = `opreq_${randomHex(16)}`;
        const result = await state.operationChannel.dispatch(token, req.mailRoute.id, req.mailRoute.capability, JSON.stringify(body), req.deadlineAt);
        ensureEpochUnchanged(req);
        writeJson(res, 200, result);
        return;
      }
      throw errorWithStatus(400, "route 不允许");
    }

    async function start() {
      if (state.startPromise) return state.startPromise;
      state.startPromise = (async () => {
        try {
          if (state.server) return stateView(state);
          // epoch 在建立任何监听之前加载：持久值不合法时直接失败关闭，绝不以 0 起步。
          state.pairingEpoch = loadPairingEpoch();
          state.instanceId = `inst_${randomHex(16)}`;
          state.profileId = `sha256:${hashHex(Services.dirsvc.get("ProfD", Ci.nsIFile).path)}`;
          state.sessionToken = randomHex(32);
          state.startedAt = new Date().toISOString();
          state.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
          state.server = createLoopbackServer(preflight, dispatch);
          state.port = state.server.port;
          refreshDescriptor();
          state.descriptorWatchdog = startDescriptorWatchdog(descriptorFile(state.instanceId), Services.appinfo.processID, state.instanceId);
          state.expiryTimer = hiddenWindow.setTimeout(() => stopService("本地会话已过期"), SESSION_TTL_MS);
          if (!state.shutdownObserver) {
            state.shutdownObserver = { observe: () => stopService("Thunderbird 正在退出") };
            Services.obs.addObserver(state.shutdownObserver, "quit-application-granted");
          }
          state.error = null;
        } catch (error) {
          stopService("本地回环服务启动失败");
          state.startPromise = null;
          console.error("Thunderbird Skill Bridge 启动失败", error);
          throw new Error(state.error);
        }
        return stateView(state);
      })();
      return state.startPromise;
    }

    return {
      thunderbirdSkillBridge: {
        start,
        getState: async () => stateView(state),
        // 与 HTTP pairing 入口保持同一套断言：同样恰好三项、同样大小写敏感、同样的 Ed25519 SPKI 形状校验。
        beginPairing: async (clientId, publicKeyAlgorithm, publicKeySpkiBase64) => {
          if (!isPairingIdentityBody({ clientId, publicKeyAlgorithm, publicKeySpkiBase64 })) throw new Error("配对身份格式不合法");
          if (state.pairing) throw new Error("已配对状态必须先显式撤销现有 client");
          const pending = state.pending;
          if (pending && Date.parse(pending.expiresAt) > Date.now() && pending.clientId !== clientId) throw new Error("已有待确认配对请求");
          state.pending = {
            intentId: `intent_${randomHex(16)}`,
            code: String(Math.floor(webCrypto.getRandomValues(new Uint32Array(1))[0] % 1000000)).padStart(6, "0"),
            clientId,
            publicKeyAlgorithm,
            publicKeySpkiBase64,
            expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
          };
          state.pairingState = "pairing";
          refreshDescriptor();
          return stateView(state);
        },
        confirmPairing: async (intentId, code) => {
          if (!state.pending || state.pending.intentId !== intentId || !constantTimeEqual(state.pending.code, code) || Date.parse(state.pending.expiresAt) <= Date.now()) throw new Error("配对确认无效或已过期");
          const confirmed = state.pending;
          // capabilities 默认空集：账号/能力授权 UI 是未来工作项，未上线前一律
          // 不自动授予任何邮件 capability，全部邮件 route 因此失败关闭。
          state.pairing = { clientId: confirmed.clientId, publicKeyAlgorithm: confirmed.publicKeyAlgorithm, publicKeySpkiBase64: confirmed.publicKeySpkiBase64, capabilities: [], createdAt: new Date().toISOString() };
          savePairing(state.pairing);
          state.receipts.set(confirmed.intentId, {
            intentId: confirmed.intentId,
            clientId: confirmed.clientId,
            publicKeyAlgorithm: confirmed.publicKeyAlgorithm,
            publicKeySpkiBase64: confirmed.publicKeySpkiBase64,
            expiresAt: confirmed.expiresAt,
            pairingState: "paired",
            receiptExpiresAt: new Date(Date.now() + PAIRING_RECEIPT_TTL_MS).toISOString(),
          });
          state.pending = null;
          state.pairingState = "paired";
          refreshDescriptor();
          return stateView(state);
        },
        revokePairing: async () => {
          // 顺序不可调换：先单调递增并持久化 epoch，再清 pairing、轮换 token、刷新 descriptor。
          // 这样即使在中途崩溃，重启后 epoch 也只会更大，绝不会让旧签名重新生效。
          state.pairingEpoch += 1n;
          savePairingEpoch(state.pairingEpoch);
          // 撤销的 client 持有的全部 opaque ref 必须随之失效，否则旧 client 的
          // ref 会在重新配对的新 client 名下被错误复用。
          if (state.pairing) state.refStore.revokeAllForClient(state.pairing.clientId);
          // 撤销前发起、仍在等待 background 响应的 operation 必须立即失败，
          // 不能悬挂到各自的请求 deadline 才超时——那样会让调用方误以为还在
          // 正常处理，也会让已经不再合法的 client 继续占用挂起槽位。
          state.operationChannel.clear("配对已被撤销");
          clearPairing();
          state.pairing = null;
          state.pending = null;
          state.receipts.clear();
          state.pairingState = "revoked";
          state.sessionToken = randomHex(32);
          refreshDescriptor();
          return stateView(state);
        },
        // background 用它在启动时自检自己的 route 登记表是否与这里的
        // MAIL_ROUTES 静态表一致，把"两份手写列表可能漂移"变成可验证的运行时断言。
        listMailRoutes: async () => MAIL_ROUTES.map((route) => route.id),
        // background 处理完（或判定未实现/拒绝）一条转发来的邮件 route 请求后
        // 调用两者之一，唤醒 dispatch() 里挂起的 Promise；找不到对应 token
        // （已超时/已响应过）时静默忽略，不对 background 暴露内部时序细节。
        respondToOperation: async (token, resultJson) => { state.operationChannel.respond(token, resultJson); },
        failOperation: async (token, errorCode, errorMessage) => { state.operationChannel.fail(token, errorCode, errorMessage); },
        onOperation: state.operationChannel.event,
        // 账号/能力授权 UI（Task #30/mail-write）写入已配对 client capabilities
        // 的唯一入口；E1 只提供该入口本身，不实现调用它的 UI。覆盖式写入
        // （不是增量 add），生产环境在该 UI 存在并调用它之前，capabilities
        // 恒为 confirmPairing 写入的空集，全部邮件 route 因此保持失败关闭。
        setMailCapabilities: async (capabilities) => {
          if (!state.pairing) throw new Error("未配对，无法设置 capabilities");
          if (!Array.isArray(capabilities) || !capabilities.every((value) => typeof value === "string" && KNOWN_MAIL_CAPABILITIES.has(value))) {
            throw new Error("capabilities 必须是已知能力标识组成的数组");
          }
          state.pairing = { ...state.pairing, capabilities: [...new Set(capabilities)] };
          savePairing(state.pairing);
          return stateView(state);
        },
      },
    };
  }

  onShutdown(isAppShutdown) {
    const state = globalThis.__tbSkillState;
    if (state?.expiryTimer) hiddenWindow.clearTimeout(state.expiryTimer);
    if (state?.shutdownObserver) try { Services.obs.removeObserver(state.shutdownObserver, "quit-application-granted"); } catch {}
    if (state?.server) try { state.server.stop(() => {}); } catch {}
    removeDescriptor(state?.instanceId);
    globalThis.__tbSkillState = null;
    if (!isAppShutdown) {
      resProto.setSubstitution(RESOURCE_NAME, null);
      Services.obs.notifyObservers(null, "startupcache-invalidate");
    }
  }
};
