import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { createSigningIdentityInKeychain, deleteSigningIdentityFromKeychain, loadSigningIdentityFromKeychain } from "../dist/auth.js";

const execFileAsync = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url);

async function liveFixture(t) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      protocolVersion: 1,
      minCliVersion: "0.2.1",
      maxCliVersion: "0.2.1",
      extensionVersion: "0.2.1",
    pairingEpoch: "0",
      instanceId: "inst_cli_test1",
      profileId: `sha256:${"1".repeat(64)}`,
      capabilities: [],
      pairingState: "unpaired",
      pairingEpoch: "0",
      authorizedAccountRefs: [],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const root = await mkdtemp(join(tmpdir(), "tb-cli-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "instances"), { mode: 0o700 });
  await writeFile(join(root, "instances", "inst_cli_test1.json"), JSON.stringify({
    descriptorVersion: 2,
    protocolVersion: 1,
    instanceId: "inst_cli_test1",
    profileId: `sha256:${"1".repeat(64)}`,
    profileLabel: "Fixture",
    pid: process.pid,
    port: address.port,
    sessionToken: "2".repeat(64),
    extensionVersion: "0.2.1",
    pairingEpoch: "0",
    startedAt: "2026-07-25T00:00:00.000Z",
    expiresAt: "2099-07-25T01:00:00.000Z",
  }), { mode: 0o600 });
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  return root;
}

test("help 展示命令且声明当前不访问邮件", () => {
  const output = execFileSync(process.execPath, [cli.pathname, "--help"], { encoding: "utf8" });
  assert.match(output, /draft create/);
  assert.match(output, /不访问邮件/);
});

test("未进入 Phase 1 的命令继续返回稳定未实现错误", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "--json", "accounts", "list"], { encoding: "utf8" });
  assert.equal(result.status, 3);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.error.code, "E_NOT_IMPLEMENTED");
});

test("status 和 doctor 可通过真实 loopback mock 握手", async (t) => {
  const root = await liveFixture(t);
  const environment = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: root };
  const statusResult = await execFileAsync(process.execPath, [cli.pathname, "--json", "status"], { encoding: "utf8", env: environment });
  const status = JSON.parse(statusResult.stdout);
  assert.equal(status.ok, true);
  assert.equal(status.data.pairingState, "unpaired");

  const doctorResult = await execFileAsync(process.execPath, [cli.pathname, "--json", "doctor", "--deep"], { encoding: "utf8", env: environment });
  const doctor = JSON.parse(doctorResult.stdout);
  assert.equal(doctor.data.healthy, true);
});

test("CLI 保留三类 409 稳定错误码并映射退出码", async (t) => {
      const conflicts = [
        { serverCode: "E_REPLAY", exitCode: 4, message: /重复 nonce/ },
        { serverCode: "E_PAIRING_PENDING", exitCode: 3, message: /完成或拒绝/ },
        { serverCode: "E_ALREADY_PAIRED", exitCode: 3, message: /显式撤销/ },
      ];
      let requestIndex = 0;
      const server = createServer((_request, response) => {
        const conflict = conflicts[requestIndex];
        requestIndex += 1;
        response.writeHead(409, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: conflict.serverCode, message: "服务端诊断" } }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const address = server.address();
      assert.equal(typeof address, "object");
      const root = await mkdtemp(join(tmpdir(), "tb-cli-conflicts-"));
      await chmod(root, 0o700);
      await mkdir(join(root, "instances"), { mode: 0o700 });
      await writeFile(join(root, "instances", "inst_cli_conflicts1.json"), JSON.stringify({
        descriptorVersion: 2,
        protocolVersion: 1,
        instanceId: "inst_cli_conflicts1",
        profileId: `sha256:9999999999999999999999999999999999999999999999999999999999999999`,
        profileLabel: "Conflict Fixture",
        pid: process.pid,
        port: address.port,
        sessionToken: "a".repeat(64),
        extensionVersion: "0.2.1",
    pairingEpoch: "0",
        startedAt: "2026-07-25T00:00:00.000Z",
        expiresAt: "2099-07-25T01:00:00.000Z",
      }), { mode: 0o600 });
      t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
      const environment = { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: root };
    
      for (const conflict of conflicts) {
        await assert.rejects(
          execFileAsync(process.execPath, [cli.pathname, "--json", "status"], { encoding: "utf8", env: environment }),
          (error) => {
            const envelope = JSON.parse(error.stdout);
            return error.code === conflict.exitCode && envelope.error.code === conflict.serverCode && conflict.message.test(envelope.error.message);
          },
        );
      }
      assert.equal(requestIndex, conflicts.length);
    });
    
    test("无实例 status 返回离线；敏感 argv 被拒绝", () => {
  const offline = spawnSync(process.execPath, [cli.pathname, "status"], { encoding: "utf8", env: { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: join(tmpdir(), "missing-thunderbird-runtime") } });
  assert.equal(offline.status, 3);
  assert.equal(JSON.parse(offline.stdout).error.code, "E_THUNDERBIRD_OFFLINE");

  const forbidden = spawnSync(process.execPath, [cli.pathname, "--token", "secret", "status"], { encoding: "utf8" });
  assert.equal(forbidden.status, 2);
  assert.equal(JSON.parse(forbidden.stdout).error.code, "E_VALIDATION");
  assert.doesNotMatch(forbidden.stdout, /secret/);
});

test("未知命令使用 usage 退出码", () => {
  const result = spawnSync(process.execPath, [cli.pathname, "unknown"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).error.code, "E_USAGE");
});

test("JSON/human 冲突、未知 flag 与多余参数失败关闭", () => {
  const cases = [
    ["--json", "--human", "status"],
    ["accounts", "list", "garbage"],
    ["setup", "garbage"],
    ["search", "--bogus"],
    ["status", "garbage"],
    ["doctor", "--deep", "--deep"],
  ];
  for (const args of cases) {
    const result = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, args.join(" "));
    assert.equal(result.stderr, "", args.join(" "));
    assert.equal(result.stdout.endsWith("\n"), true, args.join(" "));
    assert.equal(result.stdout.trim().split("\n").length, 1, args.join(" "));
    assert.equal(JSON.parse(result.stdout).error.code, "E_VALIDATION", args.join(" "));
  }
});

test("setup 创建 intent 后立即输出挑战码且不静默轮询", async (t) => {
  const clientId = `client_setup_${process.pid}_${Date.now()}`;
  await deleteSigningIdentityFromKeychain(clientId);
  const intentId = `intent_${"a".repeat(32)}`;
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/pairing/intents");
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ intentId, challengeCode: "123456", clientId, expiresAt: "2099-07-25T01:00:00.000Z", pairingState: "pairing" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => deleteSigningIdentityFromKeychain(clientId));
  const address = server.address();
  assert.equal(typeof address, "object");
  const root = await mkdtemp(join(tmpdir(), "tb-cli-setup-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "instances"), { mode: 0o700 });
  await writeFile(join(root, "instances", "inst_cli_setup1.json"), JSON.stringify({
    descriptorVersion: 2, protocolVersion: 1, instanceId: "inst_cli_setup1", profileId: `sha256:${"3".repeat(64)}`,
    profileLabel: "Setup Fixture", pid: process.pid, port: address.port, sessionToken: "4".repeat(64), extensionVersion: "0.2.1", pairingEpoch: "0",
    startedAt: "2026-07-25T00:00:00.000Z", expiresAt: "2099-07-25T01:00:00.000Z",
  }), { mode: 0o600 });
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));

  const started = Date.now();
  const result = await execFileAsync(process.execPath, [cli.pathname, "--json", "--client", clientId, "--timeout", "2000", "setup"], {
    encoding: "utf8", env: { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: root },
  });
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.data.challengeCode, "123456");
  assert.equal(envelope.data.paired, false);
  assert.equal(requestCount, 1);
  assert.ok(Date.now() - started < 1500);
});

test("setup --reconfigure 在服务端仍 paired 时保留旧 Keychain identity", { skip: process.platform !== "darwin" }, async (t) => {
  const clientId = `client_reconfigure_paired_${process.pid}_${Date.now()}`;
  const instanceId = "inst_cli_paired1";
  const profileId = `sha256:${"5".repeat(64)}`;
  await deleteSigningIdentityFromKeychain(clientId);
  const created = await createSigningIdentityInKeychain(clientId);
  assert.ok(created);
  t.after(() => deleteSigningIdentityFromKeychain(clientId));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      protocolVersion: 1, minCliVersion: "0.2.1", maxCliVersion: "0.2.1", extensionVersion: "0.2.1",
      instanceId, profileId, capabilities: [], pairingState: "paired", pairingEpoch: "0", authorizedAccountRefs: [],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const root = await mkdtemp(join(tmpdir(), "tb-cli-reconfigure-paired-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "instances"), { mode: 0o700 });
  await writeFile(join(root, "instances", `${instanceId}.json`), JSON.stringify({
    descriptorVersion: 2, protocolVersion: 1, instanceId, profileId,
    profileLabel: "Reconfigure Fixture", pid: process.pid, port: address.port, sessionToken: "6".repeat(64), extensionVersion: "0.2.1", pairingEpoch: "0",
    startedAt: "2026-07-25T00:00:00.000Z", expiresAt: "2099-07-25T01:00:00.000Z",
  }), { mode: 0o600 });
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));

  await assert.rejects(
    execFileAsync(process.execPath, [cli.pathname, "--json", "--client", clientId, "setup", "--reconfigure"], {
      encoding: "utf8", env: { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: root },
    }),
    (error) => {
      const envelope = JSON.parse(error.stdout);
      return error.code === 3 && envelope.error.code === "E_NOT_PAIRED" && /旧身份已保留/.test(envelope.error.message);
    },
  );
  assert.deepEqual(requests, ["GET /v1/status"]);
  const loaded = await loadSigningIdentityFromKeychain(clientId);
  assert.equal(loaded?.publicKeySpkiBase64, created.publicKeySpkiBase64);
});

test("setup --reconfigure 在服务端 unpaired 时复用旧 identity 发起配对", { skip: process.platform !== "darwin" }, async (t) => {
  const clientId = `client_reconfigure_unpaired_${process.pid}_${Date.now()}`;
  const instanceId = "inst_cli_unpaired1";
  const profileId = `sha256:${"7".repeat(64)}`;
  const intentId = `intent_${"b".repeat(32)}`;
  await deleteSigningIdentityFromKeychain(clientId);
  const created = await createSigningIdentityInKeychain(clientId);
  assert.ok(created);
  t.after(() => deleteSigningIdentityFromKeychain(clientId));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: 1, minCliVersion: "0.2.1", maxCliVersion: "0.2.1", extensionVersion: "0.2.1",
        instanceId, profileId, capabilities: [], pairingState: "unpaired", pairingEpoch: "0", authorizedAccountRefs: [],
      }));
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ intentId, challengeCode: "654321", clientId, expiresAt: "2099-07-25T01:00:00.000Z", pairingState: "pairing" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const root = await mkdtemp(join(tmpdir(), "tb-cli-reconfigure-unpaired-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "instances"), { mode: 0o700 });
  await writeFile(join(root, "instances", `${instanceId}.json`), JSON.stringify({
    descriptorVersion: 2, protocolVersion: 1, instanceId, profileId,
    profileLabel: "Reconfigure Fixture", pid: process.pid, port: address.port, sessionToken: "8".repeat(64), extensionVersion: "0.2.1", pairingEpoch: "0",
    startedAt: "2026-07-25T00:00:00.000Z", expiresAt: "2099-07-25T01:00:00.000Z",
  }), { mode: 0o600 });
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));

  const result = await execFileAsync(process.execPath, [cli.pathname, "--json", "--client", clientId, "setup", "--reconfigure"], {
    encoding: "utf8", env: { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: root },
  });
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.data.intentId, intentId);
  assert.equal(envelope.data.challengeCode, "654321");
  assert.deepEqual(requests, ["GET /v1/status", "POST /v1/pairing/intents"]);
  const loaded = await loadSigningIdentityFromKeychain(clientId);
  assert.equal(loaded?.publicKeySpkiBase64, created.publicKeySpkiBase64);
});

test("phase-1 仅含不访问邮件的诊断/配对/安装辅助命令", async () => {
  const { COMMANDS } = await import("../dist/contracts/commands.js");
  const phase1 = COMMANDS.filter((command) => command.phase === "phase-1").map((command) => command.path.join(" "));
  // xpi path/reveal 是纯本地安装辅助：只读、不触达 Thunderbird、不访问任何邮件数据。
  assert.deepEqual(phase1.sort(), ["doctor", "setup", "status", "xpi path", "xpi reveal"]);
  // 边界不变式：任何触达邮件/日历/草稿的命令都不得进入 phase-1。
  const mailish = /^(accounts|folders|search|message|recent|draft|attachments|calendar|watch)\b/;
  for (const path of phase1) assert.doesNotMatch(path, mailish, `${path} 不应属于 phase-1`);
  // phase-1 命令风险等级只能是只读或可逆，绝不允许 external/destructive。
  for (const command of COMMANDS.filter((c) => c.phase === "phase-1")) {
    assert.ok(["read", "reversible"].includes(command.risk), `${command.path.join(" ")} 风险等级 ${command.risk}`);
  }
});

test("E_PAIRING_CHANGED 映射为 exit 7、保留机器码与恢复提示，且写操作不自动重试", async (t) => {
  const clientId = `client_epoch_${process.pid}_${Date.now()}`;
  await deleteSigningIdentityFromKeychain(clientId);
  t.after(() => deleteSigningIdentityFromKeychain(clientId));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    request.on("end", () => {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "E_PAIRING_CHANGED", message: "配对代已变更" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const root = await mkdtemp(join(tmpdir(), "tb-cli-epoch-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "instances"), { mode: 0o700 });
  await writeFile(join(root, "instances", "inst_cli_epoch01.json"), JSON.stringify({
    descriptorVersion: 2, protocolVersion: 1, instanceId: "inst_cli_epoch01", profileId: `sha256:${"9".repeat(64)}`,
    profileLabel: "Epoch Fixture", pid: process.pid, port: address.port, sessionToken: "a".repeat(64), extensionVersion: "0.2.1", pairingEpoch: "0",
    startedAt: "2026-07-25T00:00:00.000Z", expiresAt: "2099-07-25T01:00:00.000Z",
  }), { mode: 0o600 });
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));

  await assert.rejects(
    execFileAsync(process.execPath, [cli.pathname, "--json", "--client", clientId, "setup"], {
      encoding: "utf8", env: { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: root },
    }),
    (error) => {
      const envelope = JSON.parse(error.stdout);
      return error.code === 7
        && envelope.error.code === "E_PAIRING_CHANGED"
        && envelope.error.retryable === true
        && /重新运行命令/.test(envelope.error.message);
    },
  );
  // 写操作必须只发一次：retryable 只是给调用方的提示，CLI 绝不自动重试。
  assert.deepEqual(requests, ["POST /v1/pairing/intents"]);
});

test("descriptor 的 pairingEpoch 缺失或格式非法时 CLI 拒绝该实例", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tb-cli-epochbad-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "instances"), { mode: 0o700 });
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const base = {
    descriptorVersion: 2, protocolVersion: 1, instanceId: "inst_cli_epochbad", profileId: `sha256:${"b".repeat(64)}`,
    profileLabel: "Bad Epoch", pid: process.pid, port: 49152, sessionToken: "c".repeat(64), extensionVersion: "0.2.1",
    startedAt: "2026-07-25T00:00:00.000Z", expiresAt: "2099-07-25T01:00:00.000Z",
  };
  for (const variant of [{}, { pairingEpoch: 0 }, { pairingEpoch: "007" }, { pairingEpoch: "-1" }, { pairingEpoch: "1e3" }, { pairingEpoch: "" }]) {
    await writeFile(join(root, "instances", "inst_cli_epochbad.json"), JSON.stringify({ ...base, ...variant }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [cli.pathname, "--json", "status"], {
      encoding: "utf8", env: { ...process.env, THUNDERBIRD_SKILL_RUNTIME_DIR: root },
    });
    assert.equal(result.status, 2, JSON.stringify(variant));
    assert.equal(JSON.parse(result.stdout).error.code, "E_VALIDATION", JSON.stringify(variant));
  }
});

test("xpi path 在开发仓库布局下解析到冻结 XPI 且保持 Phase 1 边界", async () => {
  const result = await execFileAsync(process.execPath, [cli.pathname, "--json", "xpi", "path"], { encoding: "utf8" });
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "xpi path");
  assert.equal(envelope.data.fileName, "thunderbird-skill-bridge.xpi");
  const [{ createHash }, { readFile }] = await Promise.all([import("node:crypto"), import("node:fs/promises")]);
  const packaged = createHash("sha256").update(await readFile(envelope.data.path)).digest("hex");
  const frozen = createHash("sha256").update(await readFile(new URL("../thunderbird-skill-bridge-phase1.xpi", import.meta.url))).digest("hex");
  assert.equal(packaged, frozen, "xpi path 必须指向仓库冻结件");
});

test("xpi path --human 只输出裸路径，便于 shell 传参", async () => {
  const result = await execFileAsync(process.execPath, [cli.pathname, "--human", "xpi", "path"], { encoding: "utf8" });
  assert.equal(result.stdout.trim().endsWith("thunderbird-skill-bridge-phase1.xpi"), true);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("xpi 命令不接受未知参数，且未越出 Phase 1 命令边界", async () => {
  for (const args of [["xpi", "path", "--install"], ["xpi", "reveal", "--force"], ["xpi", "install"]]) {
    const result = spawnSync(process.execPath, [cli.pathname, "--json", ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0, args.join(" "));
    const envelope = JSON.parse(result.stdout);
    assert.ok(["E_VALIDATION", "E_USAGE"].includes(envelope.error.code), `${args.join(" ")} -> ${envelope.error.code}`);
  }
});

test("xpi 解析不依赖 cwd，且候选路径不引用包外目录", async () => {
  const { xpiCandidatePaths } = await import("../dist/xpi.js");
  const candidates = xpiCandidatePaths("file:///opt/pkg/dist/xpi.js");
  assert.deepEqual(candidates, [
    "/opt/pkg/assets/thunderbird-skill-bridge.xpi",
    "/opt/assets/thunderbird-skill-bridge.xpi",
    "/opt/pkg/thunderbird-skill-bridge-phase1.xpi",
  ]);
  for (const p of candidates) assert.equal(p.includes(".."), false, "候选路径不得含有未解析的 ..");
  // 从任意 cwd 调用结果一致
  const a = await execFileAsync(process.execPath, [cli.pathname, "--human", "xpi", "path"], { encoding: "utf8", cwd: "/" });
  const b = await execFileAsync(process.execPath, [cli.pathname, "--human", "xpi", "path"], { encoding: "utf8", cwd: tmpdir() });
  assert.equal(a.stdout, b.stdout);
});

test("CLI 不提供任何自动安装 XPI 或绕过 Thunderbird 确认的路径", async () => {
  const [cliSource, xpiSource] = await Promise.all([
    readFile(new URL("../src/cli.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/xpi.ts", import.meta.url), "utf8"),
  ]);
  const combined = `${cliSource}\n${xpiSource}`;
  // 不得出现安装/启动 Thunderbird 或写入其 profile 的手段
  assert.doesNotMatch(combined, /xpinstall|installAddon|AddonManager|\bthunderbird\.app|open\s+-a/i);
  // reveal 只允许 open -R（在 Finder 中定位），不得是 open 直接打开文件
  assert.match(xpiSource, /"\/usr\/bin\/open", \["-R", path\]/);
});

test("--version 输出产品版本而非 envelope schema 版本，且无第二个版本源", async () => {
  const [{ CLI_SCHEMA_VERSION }, pkg] = await Promise.all([
    import("../dist/contracts/envelope.js"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const result = await execFileAsync(process.execPath, [cli.pathname, "--version"], { encoding: "utf8" });
  const reported = result.stdout.trim();
  assert.equal(reported, pkg.version, "--version 必须等于 package.json 的版本");
  assert.notEqual(reported, CLI_SCHEMA_VERSION, "--version 不得再输出 envelope schema 版本");
  assert.equal(CLI_SCHEMA_VERSION, "1.0", "envelope schema 版本独立且保持 1.0");

  // 产品版本只能来自 package.json，不允许在源码里硬编码出第二个版本源
  const versionSource = await readFile(new URL("../src/version.ts", import.meta.url), "utf8");
  assert.match(versionSource, /package\.json/);
  assert.doesNotMatch(versionSource, /"\d+\.\d+\.\d+"/, "version.ts 不得硬编码版本号");
});

test("XPI 安全评审基准清单存在且与当前产物一致", async () => {
  const [manifest, pkg] = await Promise.all([
    readFile(new URL("../release/xpi-checksums.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const entry = manifest.versions[pkg.version];
  assert.ok(entry, `清单必须包含当前版本 ${pkg.version} 的条目`);
  const { createHash } = await import("node:crypto");
  const actual = createHash("sha256").update(await readFile(new URL("../thunderbird-skill-bridge-phase1.xpi", import.meta.url))).digest("hex");
  assert.equal(actual, entry.xpiSha256, "现场生成的 XPI 必须等于评审基准");
  // 平台约束必须被显式记录，避免未来迁到 Linux 后直接改写 SHA 绕过
  assert.equal(manifest.generatorPlatform, "darwin");
  assert.match(JSON.stringify(manifest.$comment), /macOS|平台/);
});
