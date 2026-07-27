// Task #36 CLI 侧集成测试：attachments save 的授权+分块拉取+安全落盘全流程，
// 以及 operations undo 的挂载。
//
// 本机路径安全的详细单元覆盖（路径穿越/symlink/设备文件/敏感路径/已存在/
// 相对路径/摘要与长度校验/原子发布/清理）在 test/paths.test.mjs；这里覆盖
// test/paths.test.mjs 覆盖不到的、只有在完整 CLI 命令 + 网络往返里才能验证
// 的部分：attachments.save/attachments.fetch 两条 route 的编排、cursor 乱序/
// 重放、token 过期/复用/跨 client、下载中断时临时文件清理、以及 CLI 层面对
// 相对路径/敏感路径等的端到端传导（确认命令真的会命中 src/paths.ts 的校验，
// 而不是只在单元测试里正确）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { createSigningIdentityInKeychain, deleteSigningIdentityFromKeychain } from "../dist/auth.js";
import { startFakeMailApi } from "./helpers/fake-mail-api.mjs";

const execFileAsync = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url);
const isDarwin = process.platform === "darwin";

async function withIdentity(t) {
  const clientId = `client_undoatt_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await deleteSigningIdentityFromKeychain(clientId);
  const identity = await createSigningIdentityInKeychain(clientId);
  assert.ok(identity, "无法在 Keychain 创建测试用签名身份");
  t.after(() => deleteSigningIdentityFromKeychain(clientId));
  return clientId;
}

async function makeSaveDir(t) {
  const created = await mkdtemp(join(tmpdir(), "tb-attsave-"));
  await chmod(created, 0o700);
  const root = await realpath(created); // 与 src/paths.ts 内部 realpath 解析口径一致
  t.after(() => rm(created, { recursive: true, force: true }));
  return root;
}

async function writeInputFile(t, payload) {
  const dir = await mkdtemp(join(tmpdir(), "tb-attsave-input-"));
  await chmod(dir, 0o700);
  const file = join(dir, "input.json");
  await import("node:fs/promises").then(({ writeFile }) => writeFile(file, JSON.stringify(payload), { mode: 0o600 }));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  return file;
}

function sha256Digest(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function run(args, env) {
  return execFileAsync(process.execPath, [cli.pathname, "--json", ...args], { encoding: "utf8", env });
}

async function listTempParts(directory) {
  const entries = await readdir(directory);
  return entries.filter((name) => name.includes(".thunderbird-skill-") && name.endsWith(".part"));
}

// --- operations undo ---------------------------------------------------------

test("operations undo：位置引用映射为 undoToken，成功命中 route", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: { "/v1/mail/operations.undo": (body) => ({ body: { echo: body, undone: true } }) },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const result = await run(["--client", clientId, "operations", "undo", "undo_1234567890ab"], env);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.undone, true);
  assert.deepEqual(data.echo, { undoToken: "undo_1234567890ab" });
});

test("operations undo：非法 token 格式本地即失败关闭，不发起网络请求", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, { routeHandlers: { "/v1/mail/operations.undo": () => ({ body: {} }) } });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const result = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, "operations", "undo", "not-a-token"], { encoding: "utf8", env });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "E_VALIDATION");
  assert.equal(fixture.requests.filter((r) => r.url.startsWith("/v1/mail/")).length, 0);
});

test("operations undo：顶层 undo 不再是合法命令（已改为 operations undo）", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "--json", "undo", "undo_1234567890ab"], { encoding: "utf8" });
  assert.equal(JSON.parse(result.stdout).error.code, "E_USAGE");
});

// --- attachments save：授权 + 分块拉取 + 安全落盘 ---------------------------

test("attachments save：单块响应完整落盘，摘要/长度匹配，临时文件被清理", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const dir = await makeSaveDir(t);
  const content = Buffer.from("small attachment content that fits in one chunk");
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/attachments.save": (body) => ({
        body: {
          name: "report.txt", contentType: "text/plain", size: content.length,
          digest: sha256Digest(content), fetchToken: `fetch_${body.attachmentRef}`,
        },
      }),
      "/v1/mail/attachments.fetch": () => ({ body: { chunk: content.toString("base64"), cursor: null } }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { attachmentRef: "attachment_1234567890ab", directory: dir });
  const result = await run(["--client", clientId, "attachments", "save", "--input", inputFile], env);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.path, join(dir, "report.txt"));
  assert.equal(data.bytes, content.length);
  const written = await readFile(data.path);
  assert.deepEqual(written, content);
  assert.deepEqual(await listTempParts(dir), []);

  const fetchRequests = fixture.requests.filter((r) => r.url === "/v1/mail/attachments.fetch");
  assert.equal(fetchRequests.length, 1);
  assert.equal(Object.hasOwn(fetchRequests[0].body, "cursor"), false, "首次请求不应携带 cursor");
});

test("attachments save：多块响应严格按 cursor 续取直至拼接完整", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const dir = await makeSaveDir(t);
  const content = Buffer.from("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const parts = [content.subarray(0, 10), content.subarray(10, 24), content.subarray(24)];
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/attachments.save": () => ({
        body: { name: "multi.bin", contentType: "application/octet-stream", size: content.length, digest: sha256Digest(content), fetchToken: "fetch_multi" },
      }),
      "/v1/mail/attachments.fetch": (body) => {
        const index = body.cursor === undefined ? 0 : Number(body.cursor.replace("cursor_", ""));
        const isLast = index === parts.length - 1;
        return { body: { chunk: parts[index].toString("base64"), cursor: isLast ? null : `cursor_${index + 1}` } };
      },
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { attachmentRef: "attachment_multi00000", directory: dir });
  const result = await run(["--client", clientId, "attachments", "save", "--input", inputFile], env);
  const data = JSON.parse(result.stdout).data;
  const written = await readFile(data.path);
  assert.deepEqual(written, content);
  assert.equal(fixture.requests.filter((r) => r.url === "/v1/mail/attachments.fetch").length, parts.length);
  assert.deepEqual(await listTempParts(dir), []);
});

test("attachments save：cursor 未推进（重放/异常响应）时中止并清理临时文件", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const dir = await makeSaveDir(t);
  const content = Buffer.from("stalled cursor content");
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/attachments.save": () => ({
        body: { name: "stalled.bin", contentType: "application/octet-stream", size: content.length, digest: sha256Digest(content), fetchToken: "fetch_stalled" },
      }),
      // 无论请求什么，都返回同一个 cursor，永不推进——模拟异常/重放响应。
      "/v1/mail/attachments.fetch": () => ({ body: { chunk: content.subarray(0, 5).toString("base64"), cursor: "cursor_stuck" } }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { attachmentRef: "attachment_stalled0000", directory: dir });
  await assert.rejects(run(["--client", clientId, "attachments", "save", "--input", inputFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 2 && envelope.error.code === "E_VALIDATION" && /未推进/.test(envelope.error.message);
  });
  assert.deepEqual(await listTempParts(dir), [], "cursor 未推进必须清理临时文件，不留半成品");
});

test("attachments save：token 过期/复用/跨 client 由扩展拒绝时，CLI 正确传导错误并清理临时文件", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const dir = await makeSaveDir(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/attachments.save": () => ({
        body: { name: "token-test.bin", contentType: "application/octet-stream", size: 100, digest: `sha256:${"a".repeat(64)}`, fetchToken: "fetch_expired" },
      }),
      "/v1/mail/attachments.fetch": () => ({ status: 403, body: { error: { code: "E_AUTH", message: "fetch token 已过期、被复用或不属于当前 client" } } }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { attachmentRef: "attachment_tokentest00", directory: dir });
  await assert.rejects(run(["--client", clientId, "attachments", "save", "--input", inputFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 4 && envelope.error.code === "E_AUTH";
  });
  assert.deepEqual(await listTempParts(dir), []);
});

test("attachments save：中途网络/协议错误必须清理临时文件，不留半成品", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const dir = await makeSaveDir(t);
  let fetchCallCount = 0;
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/attachments.save": () => ({
        body: { name: "interrupted.bin", contentType: "application/octet-stream", size: 20, digest: `sha256:${"b".repeat(64)}`, fetchToken: "fetch_interrupted" },
      }),
      "/v1/mail/attachments.fetch": () => {
        fetchCallCount += 1;
        if (fetchCallCount === 1) return { body: { chunk: Buffer.from("first chunk ok").toString("base64"), cursor: "cursor_2" } };
        // 第二次请求返回格式非法的响应（缺少 chunk 字段），模拟中途异常中断。
        return { body: { cursor: null } };
      },
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { attachmentRef: "attachment_interrupt00", directory: dir });
  await assert.rejects(run(["--client", clientId, "attachments", "save", "--input", inputFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 2 && envelope.error.code === "E_VALIDATION";
  });
  assert.deepEqual(await listTempParts(dir), []);
  const entries = await readdir(dir);
  assert.equal(entries.includes("interrupted.bin"), false, "中断的下载不得留下最终文件");
});

test("attachments save：附件总大小超过契约硬上限时拒绝（纵深防御，即便扩展本应已拒绝签发）", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const dir = await makeSaveDir(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/attachments.save": () => ({
        body: { name: "huge.bin", contentType: "application/octet-stream", size: 10 * 1024 * 1024 + 1, digest: `sha256:${"c".repeat(64)}`, fetchToken: "fetch_huge" },
      }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { attachmentRef: "attachment_huge000000", directory: dir });
  await assert.rejects(run(["--client", clientId, "attachments", "save", "--input", inputFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 2 && envelope.error.code === "E_VALIDATION" && /硬上限/.test(envelope.error.message);
  });
  assert.equal(fixture.requests.filter((r) => r.url === "/v1/mail/attachments.fetch").length, 0, "超限不应进入分块拉取阶段");
});

test("attachments save：directory 为相对路径时本地即失败关闭，不触达 attachments.save", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, { routeHandlers: { "/v1/mail/attachments.save": () => ({ body: {} }) } });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { attachmentRef: "attachment_relative000", directory: "relative/dir" });
  await assert.rejects(run(["--client", clientId, "attachments", "save", "--input", inputFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 2 && envelope.error.code === "E_VALIDATION" && /绝对路径/.test(envelope.error.message);
  });
  assert.equal(fixture.requests.filter((r) => r.url.startsWith("/v1/mail/")).length, 0, "本地目录校验失败不应触达扩展");
});

test("attachments save：directory 落在敏感系统路径时本地即失败关闭，不触达扩展", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, { routeHandlers: { "/v1/mail/attachments.save": () => ({ body: {} }) } });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { attachmentRef: "attachment_etctest0000", directory: "/etc" });
  await assert.rejects(run(["--client", clientId, "attachments", "save", "--input", inputFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 2 && envelope.error.code === "E_VALIDATION" && /敏感系统路径/.test(envelope.error.message);
  });
  assert.equal(fixture.requests.filter((r) => r.url.startsWith("/v1/mail/")).length, 0);
});

test("attachments save：目标文件已存在时拒绝覆盖（no-clobber），且在授权之后、拉取之前就失败", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const dir = await makeSaveDir(t);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(dir, "existing.bin"), "already here"));
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/attachments.save": () => ({
        body: { name: "existing.bin", contentType: "application/octet-stream", size: 10, digest: `sha256:${"d".repeat(64)}`, fetchToken: "fetch_existing" },
      }),
      "/v1/mail/attachments.fetch": () => ({ body: { chunk: Buffer.from("0123456789").toString("base64"), cursor: null } }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { attachmentRef: "attachment_existing000", directory: dir });
  await assert.rejects(run(["--client", clientId, "attachments", "save", "--input", inputFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 2 && envelope.error.code === "E_VALIDATION" && /已存在/.test(envelope.error.message);
  });
  const surviving = await readFile(join(dir, "existing.bin"), "utf8");
  assert.equal(surviving, "already here", "已存在的文件内容不得被覆盖");
  assert.deepEqual(await listTempParts(dir), []);
});

test("attachments save：缺少 attachmentRef/directory 字段时本地失败关闭", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, { routeHandlers: {} });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const missingRef = await writeInputFile(t, { directory: "/tmp" });
  const resultA = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, "attachments", "save", "--input", missingRef], { encoding: "utf8", env });
  assert.equal(resultA.status, 2);
  assert.equal(JSON.parse(resultA.stdout).error.code, "E_VALIDATION");

  const missingDirectory = await writeInputFile(t, { attachmentRef: "attachment_1234567890ab" });
  const resultB = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, "attachments", "save", "--input", missingDirectory], { encoding: "utf8", env });
  assert.equal(resultB.status, 2);
  assert.equal(JSON.parse(resultB.stdout).error.code, "E_VALIDATION");
  assert.equal(fixture.requests.filter((r) => r.url.startsWith("/v1/mail/")).length, 0);
});
