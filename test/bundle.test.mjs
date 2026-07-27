// 确定性单文件 bundler（scripts/bundle-background.ts）的验收测试。
// 覆盖三件事：可复现性（双构建 SHA 对比）、产物结构约束（零 import/export）、
// 以及最重要的——真实加载拼接后的产物，用 vm 驱动它的 onOperation 分发，
// 证明只读域全部 7 个 handler 都被真正合并进产物（而不仅仅是"TS 源码能编译
// 通过"）。
//
// 隔离策略：每个测试都用 `tsc -p extension/tsconfig.json --outDir <临时目录>`
// 独立编译一份产物副本，再对着这份副本调用 buildBundle({ distRoot })。绝不
// 读写共享的 extension/dist/background.js——那是 `npm run build` 之后其它
// 测试文件（extension.test.mjs 等）依赖的最终产物，Node 的测试运行器可能并发
// 跑多个测试文件，谁都不该在测试期间覆盖这份共享状态。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";
import { buildBundle } from "../scripts/bundle-background.ts";
import { MAIL_ROUTES } from "../dist/contracts/routes.js";

// 从真实的 route 表派生 mock 的 listMailRoutes() 返回值，而不是在测试里
// 手写第二份 route id 列表——否则每次 routes.ts 新增 route 都要记得同步改
// 这里，历史上已经因为忘记同步而假失败过一次。
const ALL_ROUTE_IDS = MAIL_ROUTES.map((route) => route.id);

const execFileAsync = promisify(execFile);
const projectRoot = new URL("..", import.meta.url).pathname;

async function compileIsolatedCopy() {
  const outDir = await mkdtemp(join(tmpdir(), "tb-bundle-test-"));
  await execFileAsync(process.execPath, [
    join(projectRoot, "node_modules/typescript/bin/tsc"),
    "-p", join(projectRoot, "extension/tsconfig.json"),
    "--outDir", outDir,
  ]);
  return outDir;
}

async function withIsolatedBundle(t, callback) {
  const outDir = await compileIsolatedCopy();
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const bundle = await buildBundle({ distRoot: outDir });
  return callback(bundle, outDir);
}

test("buildBundle() 对相同的独立编译产物两次调用逐字节相同（可复现性）", async (t) => {
  const outDir = await compileIsolatedCopy();
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const first = await buildBundle({ distRoot: outDir });
  const second = await buildBundle({ distRoot: outDir });
  assert.equal(first, second);
  assert.equal(createHash("sha256").update(first).digest("hex"), createHash("sha256").update(second).digest("hex"));
});

test("独立两次从源码重新 tsc 编译 + bundle，产物逐字节相同（端到端可复现性）", async (t) => {
  const outDirA = await compileIsolatedCopy();
  const outDirB = await compileIsolatedCopy();
  t.after(async () => { await rm(outDirA, { recursive: true, force: true }); await rm(outDirB, { recursive: true, force: true }); });
  const bundleA = await buildBundle({ distRoot: outDirA });
  const bundleB = await buildBundle({ distRoot: outDirB });
  assert.equal(createHash("sha256").update(bundleA).digest("hex"), createHash("sha256").update(bundleB).digest("hex"), "两次独立从源码重新编译+bundle 的结果必须逐字节一致");
});

test("对已经是 bundle 产物的文件再次调用 buildBundle() 必须显式拒绝，而不是静默产生重复声明", async (t) => {
  await withIsolatedBundle(t, async (_bundle, outDir) => {
    // 模拟"忘记先重新 tsc"的误用场景：直接对同一个已经被 bundle 覆盖过的
    // 目录再跑一次。
    const { writeFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const bundle = await buildBundle({ distRoot: outDir });
    await writeFile(resolve(outDir, "background.js"), bundle, "utf8");
    await assert.rejects(buildBundle({ distRoot: outDir }), /已经是上一次 bundle 的产物/);
  });
});

test("bundle 产物零顶层 import/export", async (t) => {
  await withIsolatedBundle(t, async (bundle) => {
    for (const line of bundle.split("\n")) {
      assert.doesNotMatch(line, /^\s*import\b/, `发现未被转换的 import 行：${line}`);
      assert.doesNotMatch(line, /^\s*export\b/, `发现未被转换的 export 行：${line}`);
    }
  });
});

function createSandbox() {
  const responded = [];
  const failed = [];
  const consoleErrors = [];
  let operationListener;
  let pairingRevokedListener;
  const sandbox = {
    console: { info() {}, warn() {}, error(...args) { consoleErrors.push(args); } },
    crypto: globalThis.crypto,
    browser: {
      accounts: { list: async () => [{ id: "acc-native-1", name: "Demo", type: "imap", identities: [] }] },
      folders: { query: async () => [] },
      messages: {
        query: async () => ({ id: null, messages: [] }),
        continueList: async () => ({ id: null, messages: [] }),
        get: async () => ({ id: 1, author: "a@example.com", bccList: [], ccList: [], date: new Date(), external: false, flagged: false, headerMessageId: "x", junk: false, junkScore: 0, new: false, priority: 0, read: true, recipients: [], size: 0, subject: "s", tags: [] }),
        getFull: async () => ({}),
        getRaw: async () => "",
        listAttachments: async () => [],
      },
      messageDisplay: { open: async () => ({ tabId: 1 }) },
      thunderbirdSkillBridge: {
        start: async () => ({
          serviceStarted: true, port: 49_152, descriptorPath: "/tmp/x", instanceId: "inst_x", profileId: `sha256:${"0".repeat(64)}`,
          pairingState: "unpaired", pairingEpoch: "0", clientId: null, pendingIntentId: null, pendingCode: null, pendingClientId: null, pendingExpiresAt: null, error: null,
        }),
        listMailRoutes: async () => ALL_ROUTE_IDS,
        onOperation: { addListener: (fn) => { operationListener = fn; } },
        onPairingRevoked: { addListener: (fn) => { pairingRevokedListener = fn; } },
        respondToOperation: async (token, resultJson) => { responded.push({ token, result: JSON.parse(resultJson) }); },
        failOperation: async (token, errorCode, errorMessage) => { failed.push({ token, errorCode, errorMessage }); },
      },
    },
  };
  sandbox.globalThis = sandbox;
  return { sandbox, responded, failed, consoleErrors, getOperationListener: () => operationListener, getPairingRevokedListener: () => pairingRevokedListener };
}

async function loadBundleInSandbox(bundle) {
  const { sandbox, responded, failed, consoleErrors, getOperationListener, getPairingRevokedListener } = createSandbox();
  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox);
  // startBridge() 内部是异步的（await browser.thunderbirdSkillBridge.start()
  // 等），给事件循环一轮机会让 addListener 真正被调用。
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { responded, failed, consoleErrors, getOperationListener, getPairingRevokedListener };
}

test("bundle 加载后：route 登记表自检通过（listMailRoutes 与本地 MAIL_ROUTE_IDS 一致，无 console.error）", async (t) => {
  await withIsolatedBundle(t, async (bundle) => {
    const { consoleErrors } = await loadBundleInSandbox(bundle);
    assert.deepEqual(consoleErrors, [], "bundle 里的 route 登记表自检不应报告任何不一致");
  });
});

test("bundle 加载后：只读域全部 7 个 handler 都被真正拼接进产物并可分发（不是被摇掉的死代码）", async (t) => {
  await withIsolatedBundle(t, async (bundle) => {
    const { responded, failed, getOperationListener } = await loadBundleInSandbox(bundle);
    const listener = getOperationListener();
    assert.equal(typeof listener, "function", "onOperation 监听器必须被注册");

    const readRoutes = ["accounts.list", "folders.list", "messages.search", "messages.recent", "messages.get", "messages.open", "attachments.list"];
    for (const [index, routeId] of readRoutes.entries()) {
      await listener(`tok_${index}`, routeId, "mail.read.v1", "{}", "client_demo", "0");
    }
    // 只读域 7 个 route 全部必须真正走到了业务 handler（respondToOperation 成功，
    // 或者因为本测试没有 mock 出完整的 browser API 而 E_INTERNAL 失败）——
    // 两种结果都证明 dispatch 命中了真实 handler；唯一不允许出现的是
    // E_NOT_IMPLEMENTED，那意味着这条 route 其实没有被拼进 bundle 或没有接线。
    const notImplemented = failed.filter((entry) => entry.errorCode === "E_NOT_IMPLEMENTED");
    assert.deepEqual(notImplemented, [], "只读域 7 个已实现 route 不应落到 E_NOT_IMPLEMENTED");
    assert.equal(responded.length + failed.length, readRoutes.length);
  });
});

// 原本这里用 "messages.mark" 举例未实现 route；Task #30/mail-write 把
// 可逆域（mark/move/trash/undo/drafts/send/attachments save&fetch/
// operations）全部接入 READ_MAIL_ROUTE_HANDLERS 之后，"messages.mark" 已经
// 是已实现 route，再用它断言 E_NOT_IMPLEMENTED 会变成假失败。改用永远不会
// 存在的 route id（v0.3.0 明确排除的永久删除能力，见
// test/routes-contract.test.mjs 的 "delete/watch/calendar 零命中" 断言）来
// 验证"未知/未接入 route 一律 fail-closed 为 E_NOT_IMPLEMENTED"这条不变式，
// 不与任何已实现 route 的接入状态耦合。
test("bundle 加载后：未知/未接入的 route（如已排除的 messages.delete.confirm）仍然精确 fail-closed 为 E_NOT_IMPLEMENTED", async (t) => {
  await withIsolatedBundle(t, async (bundle) => {
    const { failed, getOperationListener } = await loadBundleInSandbox(bundle);
    const listener = getOperationListener();
    await listener("tok_x", "messages.delete.confirm", "mail.reversible.v1", "{}", "client_demo", "0");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].errorCode, "E_NOT_IMPLEMENTED");
  });
});

test("bundle 加载后：可逆/草稿/外发域（Task #30/mail-write）全部新增 handler 都被真正拼接进产物并可分发", async (t) => {
  await withIsolatedBundle(t, async (bundle) => {
    const { responded, failed, getOperationListener } = await loadBundleInSandbox(bundle);
    const listener = getOperationListener();

    const newRoutes = [
      "messages.mark", "messages.move", "messages.trash",
      "attachments.save", "attachments.fetch",
      "drafts.create", "drafts.update", "drafts.open", "drafts.send.prepare", "drafts.send.confirm",
      "operations.get", "operations.undo",
    ];
    for (const [index, routeId] of newRoutes.entries()) {
      await listener(`tok_new_${index}`, routeId, "mail.reversible.v1", "{}", "client_demo", "0");
    }
    // 同样的判定标准：只要不是 E_NOT_IMPLEMENTED，就证明 dispatch 命中了真实
    // handler（不是被误摇掉的死代码，也不是压根没接线）——handler 因为这里没
    // mock 出完整 browser API/合法 body 而在业务层面报错是预期的，不是失败。
    const notImplemented = failed.filter((entry) => entry.errorCode === "E_NOT_IMPLEMENTED");
    assert.deepEqual(notImplemented, [], "可逆/草稿/外发域全部 12 个新增 route 都不应落到 E_NOT_IMPLEMENTED（即 index.ts 从不在 bundle 翻转为在 bundle）");
    assert.equal(responded.length + failed.length, newRoutes.length);
  });
});

test("bundle 加载后：respondToOperation 成功路径真实携带 accounts.list 的业务结果（含 opaque ref）", async (t) => {
  await withIsolatedBundle(t, async (bundle) => {
    const { responded, getOperationListener } = await loadBundleInSandbox(bundle);
    const listener = getOperationListener();
    await listener("tok_ok", "accounts.list", "mail.read.v1", "{}", "client_demo", "0");
    assert.equal(responded.length, 1);
    assert.equal(responded[0].token, "tok_ok");
    assert.equal(responded[0].result.accounts.length, 1);
    assert.match(responded[0].result.accounts[0].accountRef, /^acc_[A-Za-z0-9_-]{16,128}$/);
    assert.equal(responded[0].result.accounts[0].name, "Demo");
  });
});

test("onPairingRevoked 监听器被注册，触发后不抛出（mailRefStore.clear() 真实可调用）", async (t) => {
  await withIsolatedBundle(t, async (bundle) => {
    const { getPairingRevokedListener } = await loadBundleInSandbox(bundle);
    const listener = getPairingRevokedListener();
    assert.equal(typeof listener, "function");
    assert.doesNotThrow(() => listener());
  });
});
