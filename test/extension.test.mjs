import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

const execFileAsync = promisify(execFile);

test("扩展 background 产物是 classic script 且失败路径不启用邮件访问", async () => {
  const source = await readFile(new URL("../extension/dist/background.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*(?:import|export)\b/m);
  assert.match(source, /mailAccessEnabled:\s*false/);
  assert.match(source, /Experiment API 启动失败/);
  assert.match(source, /void startBridge\(\)/);
});

test("扩展 manifest 在 Phase 1 不申请邮件权限且只声明专用 Experiment API", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.permissions, []);
  assert.deepEqual(manifest.host_permissions, []);
  assert.deepEqual(Object.keys(manifest.experiment_apis), ["thunderbirdSkillBridge"]);
  assert.equal(manifest.experiment_apis.thunderbirdSkillBridge.parent.script, "bridge/api.js");
});

test("Experiment API 只实现 status/pairing，且没有邮件 API 或 MCP 标记", async () => {
  const source = await readFile(new URL("../extension/bridge/api.js", import.meta.url), "utf8");
  assert.match(source, /@mozilla\.org\/network\/server-socket;1/);
  assert.match(source, /nsIServerSocket\.LoopbackOnly/);
  assert.match(source, /REQUEST_DEADLINE_MS/);
  assert.match(source, /MAX_HEADER_BYTES/);
  assert.match(source, /MAX_BODY_BYTES/);
  assert.match(source, /MAX_CONNECTIONS/);
  assert.match(source, /nsIAsyncOutputStream/);
  assert.match(source, /nsIOutputStreamCallback/);
  assert.match(source, /output\.asyncWait\(this/);
  assert.match(source, /quit-application-granted/);
  assert.match(source, /startDescriptorWatchdog/);
  assert.match(source, /plutil -extract instanceId raw/);
  assert.match(source, /test \"\$current_instance\" = \"\$instance\"/);
  assert.match(source, /onShutdown\(isAppShutdown\)/);
  assert.match(source, /errorWithStatus\(409, \"请求已重放\", \"E_REPLAY\"\)/);
  assert.match(source, /errorWithStatus\(409, \"已有待确认配对请求\", \"E_PAIRING_PENDING\"\)/);
  assert.match(source, /errorWithStatus\(409, \"已配对状态必须先显式撤销现有 client\", \"E_ALREADY_PAIRED\"\)/);
  assert.match(source, /const PROTOCOL_VERSION = 1/);
  assert.doesNotMatch(source, /httpd\.sys\.mjs/);
  assert.doesNotMatch(source.toLowerCase(), /tools\/list|tools\/call|jsonrpc|mailservices|browser\.(messages|accounts|compose)/);
});

test("Experiment 实际签名验证函数验证 Ed25519 并拒绝错误签名与错误 client", async () => {
  const source = await readFile(new URL("../extension/bridge/api.js", import.meta.url), "utf8");
  const start = source.indexOf("function canonical(request)");
  const end = source.indexOf("function loadPairing()", start);
  assert.ok(start >= 0 && end > start);
  // 被切片的函数引用了上方的常量，这里从同一份源码里原样抽取，避免在测试中另行硬编码。
  const constants = ["PUBLIC_KEY_ALGORITHM", "ED25519_SPKI_BASE64_LENGTH", "ED25519_SPKI_DER_BYTES", "ED25519_SPKI_PREFIX_HEX"]
    .map((name) => source.match(new RegExp(`const ${name} = [^;]+;`))?.[0])
    .join("\n");
  assert.equal(constants.includes("undefined"), false);
  const context = { webCrypto: webcrypto, decodeBase64: atob, textEncoder: new TextEncoder(), Uint8Array, Array };
  vm.createContext(context);
  vm.runInContext(`${constants}\n${source.slice(start, end)}\nglobalThis.verify = verifySignature; globalThis.canonicalize = canonical; globalThis.isEd25519Spki = isEd25519Spki;`, context);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const request = {
    method: "GET", path: "/v1/status", host: "127.0.0.1:49152", protocol: "1",
    requestId: "cli_123e4567-e89b-12d3-a456-426614174000", timestamp: "1753430400000",
    nonce: "d".repeat(32), bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    pairingEpoch: "0", clientId: "client_ed25519_fixture",
  };
  request.signature = sign(null, Buffer.from(context.canonicalize(request), "utf8"), privateKey).toString("base64");
  const pairing = { clientId: request.clientId, publicKeyAlgorithm: "Ed25519", publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  assert.equal(await context.verify(request, pairing), true);
  assert.equal(await context.verify({ ...request, signature: Buffer.alloc(64).toString("base64") }, pairing), false);
  assert.equal(await context.verify({ ...request, clientId: "client_other_fixture" }, pairing), false);
  assert.equal(await context.verify({ ...request, pairingEpoch: "1" }, pairing), false);
  assert.equal(await context.verify(request, { ...pairing, publicKeyAlgorithm: "p256" }), false);
  assert.equal(await context.verify(request, null), false);
  // 纯断言层：SPKI 形状校验独立成立，且不参与任何算法选择。
  assert.equal(context.isEd25519Spki(pairing.publicKeySpkiBase64), true);
  assert.equal(context.isEd25519Spki(pairing.publicKeySpkiBase64.slice(0, 59) + "A"), false);
  assert.equal(context.isEd25519Spki(""), false);
});

test("descriptor watchdog 跨原子刷新仅清理同一实例文件", { skip: process.platform !== "darwin" }, async (t) => {
  const source = await readFile(new URL("../extension/bridge/api.js", import.meta.url), "utf8");
  const start = source.indexOf("function descriptorWatchdogScript");
  const end = source.indexOf("function startDescriptorWatchdog");
  assert.ok(start >= 0 && end > start);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.watchdogScript = descriptorWatchdogScript();`, context);
  const root = await mkdtemp(join(tmpdir(), "tb-watchdog-test-"));
  await chmod(root, 0o700);
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const cases = [
    { name: "same", contents: JSON.stringify({ instanceId: "inst_expected", protocolVersion: 1 }), removed: true },
    { name: "different", contents: JSON.stringify({ instanceId: "inst_other", protocolVersion: 1 }), removed: false },
    { name: "malformed", contents: "{", removed: false },
    { name: "missing", contents: JSON.stringify({ protocolVersion: 1 }), removed: false },
  ];
  for (const item of cases) {
    const descriptor = join(root, `${item.name}.json`);
    await writeFile(descriptor, item.contents, { mode: 0o600 });
    await execFileAsync("/bin/sh", ["-c", context.watchdogScript, "thunderbird-skill-descriptor-watchdog", "99999999", descriptor, "inst_expected"]);
    const exists = await readFile(descriptor).then(() => true, () => false);
    assert.equal(exists, !item.removed, item.name);
  }
});

test("Experiment parser 执行请求边界并失败关闭", async () => {
  const source = await readFile(new URL("../extension/bridge/api.js", import.meta.url), "utf8");
  const constants = ["MAX_HEADER_BYTES", "MAX_BODY_BYTES"]
    .map((name) => source.match(new RegExp(`const ${name} = [^;]+;`))?.[0])
    .join("\n");
  const start = source.indexOf("function errorWithStatus");
  const end = source.indexOf("function createLoopbackServer");
  assert.ok(start >= 0 && end > start);
  const context = { TextDecoder, Uint8Array, textDecoder: new TextDecoder("utf-8", { fatal: true }) };
  vm.createContext(context);
  vm.runInContext(`${constants}\n${source.slice(start, end)}\nglobalThis.parser = { splitRequestHead, parseRequestHead, decodeRequestBody, nextReadSize, ensureRequestActive };`, context);
  const { splitRequestHead, parseRequestHead, decodeRequestBody, nextReadSize, ensureRequestActive } = context.parser;
  const statusOf = (callback) => {
    try { callback(); return 0; } catch (error) { return error.status; }
  };

  assert.equal(statusOf(() => splitRequestHead(`GET /v1/status HTTP/1.1\r\nX-Pad: ${"a".repeat(17 * 1024)}\r\n\r\n`)), 431);
  assert.equal(statusOf(() => parseRequestHead("POST /v1/status HTTP/1.1\r\nContent-Length: 16385")), 413);
  assert.equal(statusOf(() => parseRequestHead("GET /v1/status HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0")), 400);
  assert.equal(statusOf(() => parseRequestHead("POST /v1/status HTTP/1.1\r\nTransfer-Encoding: chunked\r\nContent-Length: 0")), 400);
  for (const value of ["-1", "0, 1", "1.0", ""]) {
    assert.equal(statusOf(() => parseRequestHead(`POST /v1/status HTTP/1.1\r\nContent-Length: ${value}`)), 400);
  }
  assert.equal(statusOf(() => decodeRequestBody("{}GET / HTTP/1.1\r\n\r\n", 2)), 400);
  assert.equal(statusOf(() => decodeRequestBody(String.fromCharCode(0xc3, 0x28), 2)), 400);
  assert.equal(decodeRequestBody("{}", 2), "{}");
  assert.equal(nextReadSize({ request: null, buffer: "" }, 1024 * 1024), 16 * 1024 + 5);
  assert.equal(nextReadSize({ request: { contentLength: 2 }, buffer: "" }, 1024 * 1024), 3);
  assert.equal(statusOf(() => ensureRequestActive({ deadlineAt: Date.now() - 1, isCancelled: () => false })), 408);
  assert.equal(statusOf(() => ensureRequestActive({ deadlineAt: Date.now() + 1000, isCancelled: () => true })), 408);
});

test("Experiment response writer 从异步可写回调处理 partial write 后才关闭", async () => {
  const source = await readFile(new URL("../extension/bridge/api.js", import.meta.url), "utf8");
  const start = source.indexOf("function isWouldBlock");
  const end = source.indexOf("function canonical");
  assert.ok(start >= 0 && end > start);
  const WOULD_BLOCK = Symbol("would-block");
  const context = {
    Cr: { NS_BASE_STREAM_WOULD_BLOCK: WOULD_BLOCK, NS_ERROR_ABORT: Symbol("abort") },
    Services: { tm: { mainThread: {} } },
    TextEncoder,
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nglobalThis.writer = { drainResponse };`, context);
  const writes = [];
  let callback;
  let finished = 0;
  let calls = 0;
  const output = {
    write(value) {
      calls += 1;
      if (calls === 1) { writes.push(value.slice(0, 2)); return 2; }
      if (calls === 2) throw WOULD_BLOCK;
      writes.push(value);
      return value.length;
    },
    asyncWait(value) { callback = value; },
  };
  const connection = {
    closed: false,
    responseBuffer: "abcdef",
    responseOffset: 0,
    output,
    abort() { throw new Error("不应 abort"); },
    scheduleResponseClose() { finished += 1; },
  };
  context.writer.drainResponse(connection, output);
  assert.equal(finished, 0);
  assert.equal(connection.responseOffset, 2);
  assert.equal(callback, connection);
  context.writer.drainResponse(connection, output);
  assert.equal(writes.join(""), "abcdef");
  assert.equal(finished, 1);
});

test("打包 XPI 的关键文件与当前源码逐字节一致", async () => {
  const members = ["dist/protocol.js", "dist/background.js", "dist/options.js", "bridge/schema.json", "bridge/api.js", "manifest.json", "options.html"];
  const xpi = new URL("../thunderbird-skill-bridge-phase1.xpi", import.meta.url);
  for (const member of members) {
    const [{ stdout }, source] = await Promise.all([
      execFileAsync("/usr/bin/unzip", ["-p", xpi.pathname, member], { encoding: "buffer", maxBuffer: 1024 * 1024 }),
      readFile(new URL(`../extension/${member}`, import.meta.url)),
    ]);
    assert.deepEqual(stdout, source, `${member} 与 XPI 不一致`);
  }
});

test("XPI 打包在相同源码下可重复", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tb-xpi-repro-"));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const first = join(root, "first.xpi");
  const second = join(root, "second.xpi");
  const script = new URL("../scripts/package-extension.ts", import.meta.url);
  await execFileAsync(process.execPath, [script.pathname, first]);
  await execFileAsync(process.execPath, [script.pathname, second]);
  assert.deepEqual(await readFile(first), await readFile(second));
});

test("配对 UI 将确认绑定到最后展示的 intent 和挑战码", async () => {
  const source = await readFile(new URL("../extension/src/options.ts", import.meta.url), "utf8");
  assert.match(source, /const shown = displayedIntent/);
  assert.match(source, /current\.pendingIntentId !== shown\.intentId/);
  assert.match(source, /confirmPairing\(shown\.intentId, shown\.code\)/);
  assert.doesNotMatch(source, /confirmPairing\(state\.pendingIntentId, state\.pendingCode\)/);
});

test("发布/运行版本四源完全一致，且 schemaVersion 不被卷入产品版本", async () => {
  const RELEASE_VERSION = "0.2.1";
  const [packageJson, manifest, apiSource] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../extension/manifest.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../extension/bridge/api.js", import.meta.url), "utf8"),
  ]);
  const { CLI_VERSION: transportCliVersion } = await import("../dist/transport.js");
  const { CLI_SCHEMA_VERSION } = await import("../dist/contracts/envelope.js");
  const constantOf = (name) => apiSource.match(new RegExp(`const ${name} = "([^"]+)"`))?.[1];

  // 四个版本源必须完全一致，避免 Thunderbird 安装元数据显示一个版本而 API 自报另一个。
  const sources = {
    "package.json.version": packageJson.version,
    "manifest.json.version": manifest.version,
    "api.js EXTENSION_VERSION": constantOf("EXTENSION_VERSION"),
    "api.js CLI_VERSION": constantOf("CLI_VERSION"),
    "transport CLI_VERSION": transportCliVersion,
  };
  for (const [name, value] of Object.entries(sources)) assert.equal(value, RELEASE_VERSION, name);
  assert.equal(new Set(Object.values(sources)).size, 1);
  assert.doesNotMatch(packageJson.version, /-design$/);

  // schemaVersion 是 JSON envelope 契约版本，不是产品版本：单独断言，不参与同值比较。
  assert.equal(CLI_SCHEMA_VERSION, "1.0");
  assert.notEqual(CLI_SCHEMA_VERSION, RELEASE_VERSION);

  // XPI 内的 manifest 必须与源码一致（打包不得挟带旧版本元数据）。
  const packaged = JSON.parse((await execFileAsync("/usr/bin/unzip", ["-p", new URL("../thunderbird-skill-bridge-phase1.xpi", import.meta.url).pathname, "manifest.json"], { encoding: "utf8", maxBuffer: 1024 * 1024 })).stdout);
  assert.equal(packaged.version, RELEASE_VERSION);
});

test("验证报告的验证日期不得是未来日期", async () => {
  const html = await readFile(new URL("./verification-report.html", import.meta.url), "utf8");
  const match = /验证日期：(\d{4})-(\d{2})-(\d{2})/.exec(html);
  assert.ok(match, "报告必须写明验证日期");
  const reportDate = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  assert.ok(reportDate <= today, `验证日期 ${match[0]} 不得晚于今天`);
});
