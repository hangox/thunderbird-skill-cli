// 0.3.0 邮件命令挂载的 CLI 侧测试：验证 src/cli.ts + args/input/output/session
// 把 argv/--input 正确拼成邮件 route 请求、正确处理成功/错误响应，以及
// message delete/watch/calendar 三项被明确排除在外的不变式。
//
// 使用 test/helpers/fake-mail-api.mjs 这个精简假服务端（不做签名/capability
// 校验），因为这里要验证的是 CLI 自己的职责，不是扩展侧的安全管线（那部分
// 由 test/experiment-handler.test.mjs 等覆盖）。
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { createSigningIdentityInKeychain, deleteSigningIdentityFromKeychain } from "../dist/auth.js";
import { startFakeMailApi } from "./helpers/fake-mail-api.mjs";

const execFileAsync = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url);
const isDarwin = process.platform === "darwin";

async function withIdentity(t) {
  const clientId = `client_mail_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await deleteSigningIdentityFromKeychain(clientId);
  const identity = await createSigningIdentityInKeychain(clientId);
  assert.ok(identity, "无法在 Keychain 创建测试用签名身份");
  t.after(() => deleteSigningIdentityFromKeychain(clientId));
  return clientId;
}

async function writeInputFile(t, payload) {
  const dir = await mkdtemp(join(tmpdir(), "tb-mail-input-"));
  await chmod(dir, 0o700);
  const file = join(dir, "input.json");
  await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true })));
  return file;
}

function run(args, env) {
  return execFileAsync(process.execPath, [cli.pathname, "--json", ...args], { encoding: "utf8", env });
}

test("accounts list：无 --input 时发送空 body，--include-identities 映射为 includeIdentities", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/accounts.list": (body) => ({ body: { accounts: [], receivedIncludeIdentities: body.includeIdentities ?? false } }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };

  const bare = await run(["--client", clientId, "accounts", "list"], env);
  assert.deepEqual(JSON.parse(bare.stdout).data, { accounts: [], receivedIncludeIdentities: false });

  const withFlag = await run(["--client", clientId, "accounts", "list", "--include-identities"], env);
  assert.deepEqual(JSON.parse(withFlag.stdout).data, { accounts: [], receivedIncludeIdentities: true });

  const mailRequests = fixture.requests.filter((r) => r.url.startsWith("/v1/mail/"));
  assert.equal(mailRequests.length, 2);
  assert.deepEqual(mailRequests[0].body, {});
  assert.deepEqual(mailRequests[1].body, { includeIdentities: true });
});

test("folders list：--account/--parent 映射为 accountRef/parentRef", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: { "/v1/mail/folders.list": (body) => ({ body: { echo: body } }) },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const result = await run(["--client", clientId, "folders", "list", "--account", "acc_1234567890ab", "--parent", "folder_1234567890ab"], env);
  assert.deepEqual(JSON.parse(result.stdout).data.echo, { accountRef: "acc_1234567890ab", parentRef: "folder_1234567890ab" });
});

test("search：--input 与 --limit/--cursor 合并进同一 body", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: { "/v1/mail/messages.search": (body) => ({ body: { echo: body } }) },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { query: "invoice", accountIds: ["acc_1234567890ab"] });
  const result = await run(["--client", clientId, "search", "--input", inputFile, "--limit", "10", "--cursor", "cursor_abc123"], env);
  assert.deepEqual(JSON.parse(result.stdout).data.echo, {
    query: "invoice", accountIds: ["acc_1234567890ab"], limit: 10, cursor: "cursor_abc123",
  });
});

test("search 不提供 --input 时也能成功（body 仅含 limit/cursor）", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: { "/v1/mail/messages.search": (body) => ({ body: { echo: body } }) },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const result = await run(["--client", clientId, "search", "--limit", "5"], env);
  assert.deepEqual(JSON.parse(result.stdout).data.echo, { limit: 5 });
});

test("message get：位置引用 + --format/--max-bytes", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: { "/v1/mail/messages.get": (body) => ({ body: { echo: body } }) },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const result = await run(["--client", clientId, "message", "get", "msg_1234567890ab", "--format", "markdown", "--max-bytes", "65536"], env);
  assert.deepEqual(JSON.parse(result.stdout).data.echo, { messageRef: "msg_1234567890ab", format: "markdown", maxBytes: 65_536 });
});

test("message get：非法 ref 格式与非法 --format 枚举本地即失败关闭，不发起网络请求", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, { routeHandlers: { "/v1/mail/messages.get": () => ({ body: {} }) } });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };

  const badRef = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, "message", "get", "not-a-ref"], { encoding: "utf8", env });
  assert.equal(badRef.status, 2);
  assert.equal(JSON.parse(badRef.stdout).error.code, "E_VALIDATION");

  const badFormat = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, "message", "get", "msg_1234567890ab", "--format", "pdf"], { encoding: "utf8", env });
  assert.equal(badFormat.status, 2);
  assert.equal(JSON.parse(badFormat.stdout).error.code, "E_VALIDATION");

  assert.equal(fixture.requests.filter((r) => r.url.startsWith("/v1/mail/")).length, 0, "本地校验失败不应触达扩展");
});

test("message mark/move/trash 必须提供 --input，否则 E_VALIDATION", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, { routeHandlers: {} });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  for (const args of [["message", "mark"], ["message", "move"], ["message", "trash"], ["draft", "create"], ["attachments", "save"]]) {
    const result = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, ...args], { encoding: "utf8", env });
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(JSON.parse(result.stdout).error.code, "E_VALIDATION", args.join(" "));
  }
});

test("message trash：--input 整体透传为 body，成功返回 undo token", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/messages.trash": (body) => ({ body: { operationId: "op_test0000000001", affected: body.messageRefs, undo: { token: "undo_test0001", expiresAt: "2099-01-01T00:00:00Z", summary: "将 1 封邮件移回原文件夹" } } }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { messageRefs: ["msg_1234567890ab"] });
  const result = await run(["--client", clientId, "message", "trash", "--input", inputFile], env);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.operationId, "op_test0000000001");
  assert.ok(data.undo.token.startsWith("undo_"));
});

test("draft update：位置 draftRef 与 --input 合并，冲突字段拒绝", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: { "/v1/mail/drafts.update": (body) => ({ body: { echo: body } }) },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { subject: "更新后的主题" });
  const result = await run(["--client", clientId, "draft", "update", "draft_1234567890ab", "--input", inputFile], env);
  assert.deepEqual(JSON.parse(result.stdout).data.echo, { subject: "更新后的主题", draftRef: "draft_1234567890ab" });

  const conflictFile = await writeInputFile(t, { draftRef: "draft_other0000000" });
  const conflict = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, "draft", "update", "draft_1234567890ab", "--input", conflictFile], { encoding: "utf8", env });
  assert.equal(conflict.status, 2);
  assert.equal(JSON.parse(conflict.stdout).error.code, "E_VALIDATION");
});

test("draft send：--prepare 与 --confirm 必须二选一，且分别命中对应 route", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/drafts.send.prepare": (body) => ({ body: { confirmationId: "confirm_test001", draftRef: body.draftRef, recipientDigest: "sha256:aa", subjectDigest: "sha256:bb" } }),
      "/v1/mail/drafts.send.confirm": (body) => ({ body: { sent: true, echo: body } }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };

  const neither = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, "draft", "send", "draft_1234567890ab"], { encoding: "utf8", env });
  assert.equal(neither.status, 2);
  assert.equal(JSON.parse(neither.stdout).error.code, "E_VALIDATION");

  const prepare = await run(["--client", clientId, "draft", "send", "draft_1234567890ab", "--prepare"], env);
  const prepareData = JSON.parse(prepare.stdout).data;
  assert.equal(prepareData.confirmationId, "confirm_test001");
  assert.equal(prepareData.draftRef, "draft_1234567890ab");

  const both = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, "draft", "send", "draft_1234567890ab", "--prepare", "--confirm", "-"], { encoding: "utf8", env, input: "{}" });
  assert.equal(both.status, 2);
  assert.equal(JSON.parse(both.stdout).error.code, "E_VALIDATION");

  const confirmFile = await writeInputFile(t, { confirmationId: "confirm_test001", draftRevision: "sha256:cc", confirmedAt: "2026-07-27T00:00:00Z" });
  const confirm = await run(["--client", clientId, "draft", "send", "draft_1234567890ab", "--confirm", confirmFile], env);
  const confirmData = JSON.parse(confirm.stdout).data;
  assert.equal(confirmData.sent, true);
  assert.deepEqual(confirmData.echo, { confirmationId: "confirm_test001", draftRevision: "sha256:cc", confirmedAt: "2026-07-27T00:00:00Z", draftRef: "draft_1234567890ab" });
});

test("draft send --confirm 失败时，error.details.operationId 端到端透传到 CLI 最终 JSON 输出（Task #43，不依赖 message 文本解析）", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const operationId = `op_${"e".repeat(16)}`;
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      // 模拟扩展侧 extension/bridge/api.js 的真实 HTTP error envelope 形状：
      // { error: { code, message, details } }——message 只是人类可读文案，
      // 不含任何可解析的 operationId 前缀。
      "/v1/mail/drafts.send.confirm": () => ({
        status: 500,
        body: { error: { code: "E_INTERNAL", message: "外发失败：请通过 operations get 查询最新状态，不要自动重试", details: { operationId } } },
      }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const confirmFile = await writeInputFile(t, { confirmationId: "confirm_test001", draftRevision: "sha256:cc" });

  await assert.rejects(run(["--client", clientId, "draft", "send", "draft_1234567890ab", "--confirm", confirmFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    assert.equal(error.code, 10, "E_INTERNAL 应映射为 EXIT.INTERNAL=10");
    assert.equal(envelope.error.code, "E_INTERNAL");
    assert.doesNotMatch(envelope.error.message, /op_[A-Za-z0-9_-]+/, "message 不应再包含可解析的 operationId");
    assert.deepEqual(envelope.error.details, { operationId }, "operationId 必须原样出现在结构化 details 里，而不是需要从 message 里正则提取");
    return true;
  });
});

test("CLI 独立二次 allowlist 仅保留 operationId：扩展侧 error.details 混入 token/nonce/path/subject/body/address/unexpected/嵌套字段时，CLI 端全部丢弃", { skip: !isDarwin }, async (t) => {
  // src/transport.ts 的 parseMailRouteErrorBody/sanitizeMailErrorDetails
  // 是 details 的第四道独立校验（state.ts→background.ts→api.js→transport.ts
  // 各自独立实现，互不信任对方已经处理干净，见 extension/src/mail/state.ts
  // 头部设计说明）。这里模拟"假设更上游的三道防线全部失守、扩展侧真的把
  // 敏感字段泄漏进了 HTTP 响应"的最坏场景，证明 CLI 这一层仍然独立兜底：
  // 最终 envelope.error.details 必须精确等于 { operationId }，不多不少——
  // 不是"尽量透传合法字段"，而是硬 allowlist，其余任何字段一律丢弃。
  const clientId = await withIdentity(t);
  const operationId = `op_${"f".repeat(16)}`;
  const maliciousDetails = {
    operationId,
    token: "tok_should_never_leak",
    nonce: "canary-nonce-value",
    path: "/Users/victim/.ssh/id_ed25519",
    subject: "机密主题",
    body: "机密正文内容",
    address: "victim@example.com",
    unexpected: "should be dropped",
    nested: { operationId: "op_should_not_be_read_from_here" },
  };
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/drafts.send.confirm": () => ({
        status: 500,
        body: { error: { code: "E_INTERNAL", message: "外发失败", details: maliciousDetails } },
      }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const confirmFile = await writeInputFile(t, { confirmationId: "confirm_test001", draftRevision: "sha256:cc" });

  await assert.rejects(run(["--client", clientId, "draft", "send", "draft_1234567890ab", "--confirm", confirmFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    assert.deepEqual(envelope.error.details, { operationId }, "CLI 独立二次 allowlist 必须只保留 operationId，其余字段全部丢弃");
    const raw = JSON.stringify(envelope.error.details);
    for (const canary of ["tok_should_never_leak", "canary-nonce-value", "id_ed25519", "机密主题", "机密正文内容", "victim@example.com", "should be dropped", "op_should_not_be_read_from_here"]) {
      assert.doesNotMatch(raw, new RegExp(canary.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")), `details 不应包含 canary：${canary}`);
    }
    return true;
  });
});

test("operations get：位置引用映射为 operationId", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: { "/v1/mail/operations.get": (body) => ({ body: { echo: body, state: "completed" } }) },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const result = await run(["--client", clientId, "operations", "get", "op_1234567890ab"], env);
  assert.deepEqual(JSON.parse(result.stdout).data.echo, { operationId: "op_1234567890ab" });
});

test("扩展侧错误码正确映射退出码：E_POLICY_DENIED=5，E_NOT_FOUND=6，E_CONFIRMATION_REQUIRED=5", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, {
    routeHandlers: {
      "/v1/mail/accounts.list": () => ({ status: 403, body: { error: { code: "E_POLICY_DENIED", message: "当前配对未获授予该能力" } } }),
      "/v1/mail/messages.get": () => ({ status: 404, body: { error: { code: "E_NOT_FOUND", message: "对象不存在" } } }),
      "/v1/mail/drafts.send.confirm": () => ({ status: 409, body: { error: { code: "E_CONFIRMATION_REQUIRED", message: "确认已失效" } } }),
    },
  });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };

  // 用 spawnSync 会阻塞父进程整个事件循环，导致跑在同一进程内的假服务端
  // 收不到子进程发来的请求直到子进程自己先超时退出——这是"父进程内假服务端 +
  // 子进程同步等待"组合的经典死锁/假超时陷阱。凡是期望真正走完一次网络往返
  // 的用例必须用 execFileAsync（保持事件循环运转），spawnSync 只适用于纯本地
  // 校验失败、不触达网络的场景（本文件其余用例）。
  await assert.rejects(run(["--client", clientId, "accounts", "list"], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 5 && envelope.error.code === "E_POLICY_DENIED";
  });

  await assert.rejects(run(["--client", clientId, "message", "get", "msg_1234567890ab"], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 6 && envelope.error.code === "E_NOT_FOUND";
  });

  const confirmFile = await writeInputFile(t, { confirmationId: "confirm_expired0" });
  await assert.rejects(run(["--client", clientId, "draft", "send", "draft_1234567890ab", "--confirm", confirmFile], env), (error) => {
    const envelope = JSON.parse(error.stdout);
    return error.code === 5 && envelope.error.code === "E_CONFIRMATION_REQUIRED";
  });
});

test("邮件命令强制要求身份：缺 --client 为 E_NOT_PAIRED(3)，未知 --client 为 E_AUTH(4)", { skip: !isDarwin }, async (t) => {
  const fixture = await startFakeMailApi(t, { routeHandlers: { "/v1/mail/accounts.list": () => ({ body: {} }) } });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };

  const noClient = spawnSync(process.execPath, [cli.pathname, "--json", "accounts", "list"], { encoding: "utf8", env });
  assert.equal(noClient.status, 3);
  assert.equal(JSON.parse(noClient.stdout).error.code, "E_NOT_PAIRED");

  const unknownClient = spawnSync(process.execPath, [cli.pathname, "--json", "--client", `client_unknown_${process.pid}_${Date.now()}`, "accounts", "list"], { encoding: "utf8", env });
  assert.equal(unknownClient.status, 4);
  assert.equal(JSON.parse(unknownClient.stdout).error.code, "E_AUTH");
  assert.equal(fixture.requests.filter((r) => r.url.startsWith("/v1/mail/")).length, 0, "身份缺失时不应发起邮件 route 请求");
});

test("--input 内容拒绝 __proto__/prototype/constructor 键", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, { routeHandlers: { "/v1/mail/drafts.create": () => ({ body: {} }) } });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  const inputFile = await writeInputFile(t, { subject: "x", __proto__: { polluted: true } });
  // JSON.stringify 不会序列化字面量 __proto__ 赋值（它设置的是原型而非自有属性），
  // 因此改用手写 JSON 文本，确保真正产生一个名为 "__proto__" 的自有 JSON 键。
  const { writeFile } = await import("node:fs/promises");
  await writeFile(inputFile, '{"subject":"x","__proto__":{"polluted":true}}', { mode: 0o600 });
  const result = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, "draft", "create", "--input", inputFile], { encoding: "utf8", env });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "E_VALIDATION");
  assert.equal(fixture.requests.filter((r) => r.url.startsWith("/v1/mail/")).length, 0);
});

test("message delete / watch / calendar 不接受任何参数，恒定 E_NOT_IMPLEMENTED（本轮明确排除）", { skip: !isDarwin }, async (t) => {
  const clientId = await withIdentity(t);
  const fixture = await startFakeMailApi(t, { routeHandlers: {} });
  const env = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: fixture.root };
  for (const args of [
    ["message", "delete", "msg_1234567890ab"],
    ["message", "delete", "--input", "-"],
    ["watch"],
    ["watch", "--duration", "60"],
    ["calendar", "list"],
    ["calendar", "events"],
  ]) {
    const result = spawnSync(process.execPath, [cli.pathname, "--json", "--client", clientId, ...args], { encoding: "utf8", env });
    assert.equal(result.status, args.some((a) => a.startsWith("--") || a === "msg_1234567890ab") ? 2 : 3, args.join(" "));
    const code = JSON.parse(result.stdout).error.code;
    assert.ok(["E_NOT_IMPLEMENTED", "E_VALIDATION"].includes(code), `${args.join(" ")} -> ${code}`);
  }
  assert.equal(fixture.requests.filter((r) => r.url.startsWith("/v1/mail/")).length, 0, "排除命令不应触达任何邮件 route");
});
