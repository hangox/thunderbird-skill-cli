// 可逆/草稿/外发邮件域（Task #30/#40，mail-write）的深度集成回归测试。
//
// 与 test/mail-read-integration.test.mjs 同样的分工原则：test/bundle.test.mjs
// 只验证"12 个新 handler 真的被拼进产物且能分发"（最小 mock）；这个文件验证
// "这些 handler 的业务行为是否正确"，用真实 bundle（复用
// scripts/bundle-background.ts 的 buildBundle()，对独立编译产物工作，不碰
// 共享的 extension/dist/background.js）+ 更真实的 browser.* mock 跑通全部
// 关键路径。
//
// 唯一的额外基础设施：一个可从测试代码外部推进的 MockDate，注入到 vm 沙箱
// 里替换全局 Date——undo token（10 分钟）、confirm token（5 分钟）、
// attachments fetch token（2 分钟）的真实过期都需要它，真等待真实时间不现实。
// RefStore 本身的通用过期/一次性消费/容量回收机制已经在 test/refs.test.mjs
// 单独覆盖，这里不重复验证那部分，只验证"各 handler 有没有接对 TTL 常量、
// 接对错误码语义"。
//
// 不含任何真实发送（compose.sendMessage 全程是本文件内的 mock，从不触达
// 真实 Thunderbird/SMTP）、不含任何真实账号或个人 profile。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";
import { buildBundle } from "../scripts/bundle-background.ts";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("..", import.meta.url).pathname;

let cachedOutDir;
let cachedBundle;

async function getBundle() {
  if (cachedBundle) return cachedBundle;
  cachedOutDir = await mkdtemp(join(tmpdir(), "tb-mail-write-integration-"));
  await execFileAsync(process.execPath, [
    join(projectRoot, "node_modules/typescript/bin/tsc"),
    "-p", join(projectRoot, "extension/tsconfig.json"),
    "--outDir", cachedOutDir,
  ]);
  cachedBundle = await buildBundle({ distRoot: cachedOutDir });
  return cachedBundle;
}

after(async () => {
  if (cachedOutDir) await rm(cachedOutDir, { recursive: true, force: true });
});

const ALL_ROUTE_IDS = [
  "accounts.list", "folders.list", "messages.search", "messages.recent", "messages.get", "messages.open",
  "messages.mark", "messages.move", "messages.trash", "attachments.list", "attachments.save", "attachments.fetch",
  "drafts.create", "drafts.update", "drafts.open", "drafts.send.prepare", "drafts.send.confirm", "operations.get", "operations.undo",
];

// ---------------------------------------------------------------------------
// browser.* mock：账号 account1，Inbox（trash 特殊文件夹也在同一账号树下，
// findTrashFolder() 靠深度优先搜 specialUse 命中它）。消息/文件夹/附件/
// compose tab 都用可变 Map，供各测试用例互相独立地读写与断言调用次数。
// ---------------------------------------------------------------------------
function buildWriteBrowserMock() {
  const folders = {
    inbox: { id: "folder-inbox", accountId: "account1", name: "Inbox", path: "/Inbox", specialUse: ["inbox"], subFolders: [] },
    trash: { id: "folder-trash", accountId: "account1", name: "Trash", path: "/Trash", specialUse: ["trash"], subFolders: [] },
    archive: { id: "folder-archive", accountId: "account1", name: "Archive", path: "/Archive", specialUse: [], subFolders: [] },
  };
  const folderById = new Map(Object.values(folders).map((f) => [f.id, f]));

  let nextMessageId = 100;
  const messages = new Map(); // id -> header
  function addMessage(overrides) {
    const id = nextMessageId++;
    messages.set(id, {
      id, author: "sender@example.com", bccList: [], ccList: [], date: new Date("2026-07-20T10:00:00Z"),
      external: false, flagged: false, headerMessageId: `<msg${id}@example.com>`, junk: false, junkScore: 0, new: false,
      priority: 0, read: false, recipients: ["me@example.com"], size: 100, subject: "test", tags: [],
      folder: folders.inbox, accountId: "account1",
      ...overrides,
    });
    return id;
  }

  const attachmentsByMessage = new Map(); // messageId -> [{contentType,name,partName,size}]
  const attachmentBytes = new Map(); // `${messageId}:${partName}` -> Uint8Array

  const updateCalls = [];
  const moveCalls = [];

  let nextTabId = 1;
  const composeTabs = new Map(); // tabId -> { details, closed }
  const savedMessagesByTab = new Map(); // tabId -> last saved native message id
  const sendAttempts = []; // { tabId }
  let sendShouldFail = false;

  const mock = {
    accounts: {
      list: async () => [{ id: "account1", name: "Demo", type: "imap", identities: [{ id: "id1", accountId: "account1", name: "Alice", email: "alice@example.com", default: true }], folders: [folders.inbox, folders.trash, folders.archive] }],
      get: async (id) => (id === "account1" ? { id: "account1", name: "Demo", type: "imap", identities: [], folders: [folders.inbox, folders.trash, folders.archive] } : null),
    },
    folders: {
      query: async () => [],
      get: async (id) => { const f = folderById.get(id); if (!f) throw new Error("not found"); return f; },
      getSubFolders: async () => [],
    },
    messages: {
      query: async () => ({ id: null, messages: [...messages.values()] }),
      continueList: async () => ({ id: null, messages: [] }),
      get: async (id) => { const m = messages.get(id); if (!m) throw new Error("not found"); return m; },
      getFull: async () => ({}),
      getRaw: async () => "",
      listAttachments: async (id) => attachmentsByMessage.get(id) ?? [],
      getAttachmentFile: async (id, partName) => {
        const bytes = attachmentBytes.get(`${id}:${partName}`);
        if (!bytes) throw new Error("attachment not found");
        return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
      },
      update: async (id, patch) => {
        // patch 是 vm 沙箱内创建的对象字面量，跨 realm 的 Object.prototype 与
        // 外层 Node 进程不同——直接用 assert.deepEqual 比较会得到 Node 的
        // "same structure but not reference-equal" 假失败（沙箱 realm 的
        // {} 与外层 realm 的 {} 原型不同一）。这里落地时立即做一次
        // JSON 往返，归一化成外层 realm 的纯对象，供测试断言使用。
        updateCalls.push({ id, patch: JSON.parse(JSON.stringify(patch)) });
        const current = messages.get(id);
        if (!current) throw new Error("not found");
        messages.set(id, { ...current, ...patch });
      },
      move: async (ids, destination) => {
        moveCalls.push({ ids: [...ids], destination: destination.id });
        for (const id of ids) {
          const current = messages.get(id);
          if (!current) throw new Error("not found");
          messages.set(id, { ...current, folder: destination, accountId: destination.accountId });
        }
      },
    },
    messageDisplay: { open: async ({ messageId }) => ({ tabId: 900 + messageId, windowId: 1 }) },
    compose: {
      beginNew: async (arg) => {
        const tabId = nextTabId++;
        if (typeof arg === "number") {
          // "以草稿为蓝本重开"路径：arg 是原生 messageId。
          const source = messages.get(arg);
          composeTabs.set(tabId, { details: { to: source?.recipients ?? [], subject: source?.subject ?? "", body: "" }, closed: false });
        } else {
          composeTabs.set(tabId, { details: { ...arg }, closed: false });
        }
        return { id: tabId };
      },
      getComposeDetails: async (tabId) => {
        const tab = composeTabs.get(tabId);
        if (!tab || tab.closed) throw new Error("no such tab");
        return { ...tab.details };
      },
      setComposeDetails: async (tabId, patch) => {
        const tab = composeTabs.get(tabId);
        if (!tab || tab.closed) throw new Error("no such tab");
        tab.details = { ...tab.details, ...patch };
      },
      saveMessage: async (tabId) => {
        const tab = composeTabs.get(tabId);
        if (!tab || tab.closed) throw new Error("no such tab");
        const id = addMessage({ subject: tab.details.subject ?? "", recipients: tab.details.to ?? [] });
        savedMessagesByTab.set(tabId, id);
        return { messages: [messages.get(id)], mode: "draft" };
      },
      sendMessage: async (tabId) => {
        sendAttempts.push({ tabId });
        if (sendShouldFail) throw new Error("simulated send failure");
        const tab = composeTabs.get(tabId);
        if (tab) tab.sent = true;
        return { mode: "sendNow" };
      },
    },
    tabs: {
      get: async (tabId) => {
        const tab = composeTabs.get(tabId);
        if (!tab || tab.closed) throw new Error("tab not found");
        return { id: tabId };
      },
    },
  };

  return {
    mock,
    folders,
    addMessage,
    closeTab: (tabId) => { const tab = composeTabs.get(tabId); if (tab) tab.closed = true; },
    setComposeDetailsDirectly: (tabId, patch) => { const tab = composeTabs.get(tabId); if (tab) tab.details = { ...tab.details, ...patch }; },
    setAttachment: (messageId, attachment, bytes) => {
      attachmentsByMessage.set(messageId, [...(attachmentsByMessage.get(messageId) ?? []), attachment]);
      attachmentBytes.set(`${messageId}:${attachment.partName}`, bytes);
    },
    updateCalls, moveCalls, sendAttempts,
    setSendShouldFail: (value) => { sendShouldFail = value; },
    tabSent: (tabId) => Boolean(composeTabs.get(tabId)?.sent),
  };
}

// ---------------------------------------------------------------------------
// 可从沙箱外部推进的 MockDate：undo/confirm/attachments-fetch 的一次性令牌
// TTL（10 分钟/5 分钟/2 分钟）在真实时间下不现实，注入这个类替换沙箱全局
// Date 后可以在测试里 `advanceClock(ms)` 精确推进，`Date.now()`/`new Date()`
// 在 bundle 代码内部读到的都是这个可控时钟。
// ---------------------------------------------------------------------------
function createSandbox() {
  let clockMs = Date.now();
  const RealDate = Date;
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clockMs);
      else super(...args);
    }
    static now() { return clockMs; }
  }

  const responded = [];
  const failed = [];
  const consoleErrors = [];
  const consoleInfos = [];
  let operationListener;
  const browserWrite = buildWriteBrowserMock();

  const sandbox = {
    console: { info(...args) { consoleInfos.push(args); }, warn() {}, error(...args) { consoleErrors.push(args); } },
    crypto: globalThis.crypto,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    TextEncoder, TextDecoder,
    Date: MockDate,
    browser: {
      ...browserWrite.mock,
      thunderbirdSkillBridge: {
        start: async () => ({
          serviceStarted: true, port: 49_152, descriptorPath: "/tmp/x", instanceId: "inst_x", profileId: `sha256:${"0".repeat(64)}`,
          pairingState: "unpaired", pairingEpoch: "0", clientId: null, pendingIntentId: null, pendingCode: null, pendingClientId: null, pendingExpiresAt: null, error: null,
        }),
        listMailRoutes: async () => ALL_ROUTE_IDS,
        onOperation: { addListener: (fn) => { operationListener = fn; } },
        onPairingRevoked: { addListener: () => {} },
        respondToOperation: async (token, resultJson) => { responded.push({ token, result: JSON.parse(resultJson) }); },
        failOperation: async (token, errorCode, errorMessage) => { failed.push({ token, errorCode, errorMessage }); },
      },
    },
  };
  sandbox.globalThis = sandbox;
  return { sandbox, responded, failed, consoleErrors, consoleInfos, browserWrite, getOperationListener: () => operationListener, advanceClock: (ms) => { clockMs += ms; } };
}

async function loadBundleInSandbox(bundle) {
  const ctx = createSandbox();
  vm.createContext(ctx.sandbox);
  vm.runInContext(bundle, ctx.sandbox);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return ctx;
}

function makeCaller(listener, responded, failed) {
  return async (routeId, body, clientId = "client_A", epoch = "0") => {
    responded.length = 0; failed.length = 0;
    const token = `tok_${routeId}_${Math.random()}`;
    const capability = routeId.startsWith("drafts.send") ? "mail.send-confirmed.v1" : routeId.startsWith("drafts.") ? "draft.write.v1" : "mail.reversible.v1";
    await listener(token, routeId, capability, JSON.stringify(body), clientId, epoch);
    if (failed.length > 0) return { ok: false, errorCode: failed[0].errorCode, errorMessage: failed[0].errorMessage };
    return { ok: true, result: responded[0].result };
  };
}

async function setupIdentity(call) {
  const accountsRes = await call("accounts.list", { includeIdentities: true });
  return accountsRes.result.accounts[0].identities[0].identityRef;
}

// ---------------------------------------------------------------------------
// message mark / move / trash
// ---------------------------------------------------------------------------

test("message mark：成功路径签发 undo token，缺 read/flagged/junk/tags 全部时 E_VALIDATION", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const nativeId = ctx.browserWrite.addMessage({ read: false, flagged: false });

  // 先用 folders.list（走已在 bundle 里的只读 handler）拿不到 msgRef，mark
  // 需要的是 msg_ ref——通过 messages.search 签发。
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages.find((m) => m.messageRef).messageRef;
  void nativeId;

  const badResult = await call("messages.mark", { messageRefs: [msgRef] });
  assert.equal(badResult.ok, false);
  assert.equal(badResult.errorCode, "E_VALIDATION");

  const result = await call("messages.mark", { messageRefs: [msgRef], read: true, flagged: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.result.operationId, /^op_[A-Za-z0-9_-]{16,128}$/);
  assert.match(result.result.undo.token, /^undo_[A-Za-z0-9_-]{16,128}$/);
  assert.deepEqual(result.result.affected, [msgRef]);
  assert.equal(ctx.browserWrite.updateCalls.length, 1);
  assert.deepEqual(ctx.browserWrite.updateCalls[0].patch, { read: true, flagged: true });
});

test("message mark：批量超过 20 封 E_POLICY_DENIED，不执行任何一条", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const refs = [];
  for (let i = 0; i < 21; i += 1) {
    ctx.browserWrite.addMessage({});
  }
  const searchRes = await call("messages.search", {});
  for (const m of searchRes.result.messages) refs.push(m.messageRef);
  assert.ok(refs.length >= 21);

  const result = await call("messages.mark", { messageRefs: refs.slice(0, 21), read: true });
  assert.equal(result.ok, false);
  // Task #42 收敛：schema 层的 DoS 防护上限（100）与 policy.ts 的语义阈值
  // （mark=20）已分离，超过 20 但仍在 schema 上限内必须精确命中
  // assertBatchLimit() 返回 E_POLICY_DENIED，不再被 schema 抢先拦成
  // E_VALIDATION。
  assert.equal(result.errorCode, "E_POLICY_DENIED");
  assert.equal(ctx.browserWrite.updateCalls.length, 0, "批量超限必须不执行任何一条 update");
});

test("message mark：幂等——同一 client 对逐字段相同请求重复调用只真正执行一次", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({});
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;

  const body = { messageRefs: [msgRef], read: true };
  const first = await call("messages.mark", body);
  const second = await call("messages.mark", body);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.result.operationId, second.result.operationId, "幂等命中应返回同一次结果，不是新的 operationId");
  assert.equal(ctx.browserWrite.updateCalls.length, 1, "第二次调用不应真正再执行一次 browser.messages.update");
});

test("message move：成功路径移动到目标文件夹并签发 undo；批量超过 10 封 E_POLICY_DENIED", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({});
  const foldersRes = await call("folders.list", {});
  const archiveRef = foldersRes.result.folders.find((f) => f.name === "Archive").folderRef;
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;

  const moved = await call("messages.move", { messageRefs: [msgRef], targetFolderRef: archiveRef });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(ctx.browserWrite.moveCalls.at(-1).destination, "folder-archive");
  assert.match(moved.result.undo.token, /^undo_/);

  for (let i = 0; i < 11; i += 1) ctx.browserWrite.addMessage({});
  const search2 = await call("messages.search", {});
  const manyRefs = search2.result.messages.map((m) => m.messageRef).slice(0, 11);
  const overLimit = await call("messages.move", { messageRefs: manyRefs, targetFolderRef: archiveRef });
  assert.equal(overLimit.ok, false);
  // Task #42 收敛：同 mark，超过 policy 阈值（move=10）但仍在 schema 的
  // DoS 上限（100）内，必须精确命中 E_POLICY_DENIED。
  assert.equal(overLimit.errorCode, "E_POLICY_DENIED");
  assert.equal(ctx.browserWrite.moveCalls.length, 1, "批量超限必须不执行任何一条 move（此前那次成功 move 除外）");
});

test("message trash：移入 specialUse=trash 文件夹（不调用 delete），批量超过 5 封 E_POLICY_DENIED", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({});
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;

  const trashed = await call("messages.trash", { messageRefs: [msgRef] });
  assert.equal(trashed.ok, true, JSON.stringify(trashed));
  assert.equal(ctx.browserWrite.moveCalls.at(-1).destination, "folder-trash");

  for (let i = 0; i < 6; i += 1) ctx.browserWrite.addMessage({});
  const search2 = await call("messages.search", {});
  const manyRefs = search2.result.messages.map((m) => m.messageRef).slice(0, 6);
  const overLimit = await call("messages.trash", { messageRefs: manyRefs });
  assert.equal(overLimit.ok, false);
  // Task #42 收敛：同上，超过 policy 阈值（trash=5）但仍在 schema 的
  // DoS 上限（100）内，必须精确命中 E_POLICY_DENIED。
  assert.equal(overLimit.errorCode, "E_POLICY_DENIED");
  assert.equal(ctx.browserWrite.moveCalls.length, 1, "批量超限必须不执行任何一条 move（此前那次成功 trash 除外）");
});

test("写请求限流：同一 client 短时间内超过 60 次写请求 E_POLICY_DENIED", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({});
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;

  let lastResult;
  for (let i = 0; i < 61; i += 1) {
    // 每次请求体不同（tags 里塞入递增序号），避免被幂等缓存短路而没有真正
    // 计入限流窗口。
    lastResult = await call("messages.mark", { messageRefs: [msgRef], tags: [`t${i}`] });
    if (!lastResult.ok) break;
  }
  assert.equal(lastResult.ok, false);
  assert.equal(lastResult.errorCode, "E_POLICY_DENIED");
});

// ---------------------------------------------------------------------------
// operations.undo
// ---------------------------------------------------------------------------

test("operations undo：撤销 mark 恢复原标记，token 一次性消费，第二次 E_NOT_FOUND", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({ read: false, flagged: false });
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;

  const marked = await call("messages.mark", { messageRefs: [msgRef], read: true, flagged: true });
  assert.equal(marked.ok, true);
  const undoToken = marked.result.undo.token;

  const undone = await call("operations.undo", { undoToken });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(undone.result.restored, 1);
  const lastUpdate = ctx.browserWrite.updateCalls.at(-1);
  // mutate.ts 的 undo 快照会记录 read/flagged/junk/tags 全部 4 个字段
  // （不只是被改动的那些），因此还原时的 patch 也是全量 4 字段。
  assert.deepEqual(lastUpdate.patch, { read: false, flagged: false, junk: false, tags: [] });

  const secondAttempt = await call("operations.undo", { undoToken });
  assert.equal(secondAttempt.ok, false);
  assert.equal(secondAttempt.errorCode, "E_NOT_FOUND");
});

test("operations undo：跨 client 与跨 pairingEpoch 均 E_NOT_FOUND", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({});
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;
  const marked = await call("messages.mark", { messageRefs: [msgRef], read: true });
  const undoToken = marked.result.undo.token;

  const crossClient = await call("operations.undo", { undoToken }, "client_B", "0");
  assert.equal(crossClient.ok, false);
  assert.equal(crossClient.errorCode, "E_NOT_FOUND");

  const crossEpoch = await call("operations.undo", { undoToken }, "client_A", "1");
  assert.equal(crossEpoch.ok, false);
  assert.equal(crossEpoch.errorCode, "E_NOT_FOUND");

  // 证明上面两次拒绝不是 token 本身已经失效——同 client 同 epoch 仍能成功兑现。
  const legit = await call("operations.undo", { undoToken }, "client_A", "0");
  assert.equal(legit.ok, true, JSON.stringify(legit));
});

test("operations undo：超过 10 分钟 TTL 后过期 E_NOT_FOUND", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({});
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;
  const marked = await call("messages.mark", { messageRefs: [msgRef], read: true });
  const undoToken = marked.result.undo.token;

  ctx.advanceClock(10 * 60 * 1000 + 1);
  const expired = await call("operations.undo", { undoToken });
  assert.equal(expired.ok, false);
  assert.equal(expired.errorCode, "E_NOT_FOUND");
});

test("operations get：查询 mark 产生的 operation 状态，undo 后变为 undone", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({});
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;
  const marked = await call("messages.mark", { messageRefs: [msgRef], read: true });

  const before = await call("operations.get", { operationId: marked.result.operationId });
  assert.equal(before.ok, true);
  assert.equal(before.result.state, "completed");
  assert.equal(before.result.undoable, true);

  await call("operations.undo", { undoToken: marked.result.undo.token });
  const after = await call("operations.get", { operationId: marked.result.operationId });
  assert.equal(after.ok, true);
  assert.equal(after.result.state, "undone");
  assert.equal(after.result.undoable, false);
});

// ---------------------------------------------------------------------------
// draft create / update / open
// ---------------------------------------------------------------------------

test("draft create：成功创建并保存草稿，返回 draftRef 绑定存活 compose tab", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const identityRef = await setupIdentity(call);

  const created = await call("drafts.create", { identityRef, to: ["bob@example.com"], subject: "hello", body: "world" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.result.draftRef, /^draft_[A-Za-z0-9_-]{16,128}$/);
  assert.deepEqual(created.result.to, ["bob@example.com"]);
  assert.equal(created.result.bodyPreview, "world");
});

test("draft update：撰写窗口存活时成功合并更新；窗口已关闭时明确拒绝", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const identityRef = await setupIdentity(call);
  const created = await call("drafts.create", { identityRef, subject: "orig" });

  const updated = await call("drafts.update", { draftRef: created.result.draftRef, subject: "updated" });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(updated.result.subject, "updated");

  ctx.browserWrite.closeTab(updated.result.composeTabId);
  const afterClose = await call("drafts.update", { draftRef: updated.result.draftRef, subject: "again" });
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.errorCode, "E_VALIDATION");
});

test("draft open：撰写窗口仍存活时复用同一 tab；已关闭时重开", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const identityRef = await setupIdentity(call);
  const created = await call("drafts.create", { identityRef, subject: "reopen-me" });

  const openedAlive = await call("drafts.open", { draftRef: created.result.draftRef });
  assert.equal(openedAlive.ok, true, JSON.stringify(openedAlive));
  assert.equal(openedAlive.result.composeTabId, created.result.composeTabId);

  ctx.browserWrite.closeTab(openedAlive.result.composeTabId);
  const openedReopened = await call("drafts.open", { draftRef: openedAlive.result.draftRef });
  assert.equal(openedReopened.ok, true, JSON.stringify(openedReopened));
  assert.notEqual(openedReopened.result.composeTabId, openedAlive.result.composeTabId, "重开必须产生新的 compose tab");
});

// ---------------------------------------------------------------------------
// draft send prepare / confirm
// ---------------------------------------------------------------------------

async function createDraftForSend(call) {
  const identityRef = await setupIdentity(call);
  return call("drafts.create", { identityRef, to: ["bob@example.com"], subject: "send-me", body: "payload" });
}

test("draft send：prepare 生成四路摘要，confirm 成功后 token 一次性消费", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);

  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  for (const field of ["revision", "recipientDigest", "subjectDigest", "attachmentDigest"]) {
    assert.match(prepared.result[field], /^sha256:[0-9a-f]{64}$/, field);
  }

  const confirmed = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.equal(confirmed.result.sent, true);
  assert.ok(ctx.browserWrite.tabSent(created.result.composeTabId));

  const replay = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 1, "重放 confirm 不得触发第二次真实发送调用");
});

test("draft send：confirm 超过 5 分钟 TTL 过期 E_CONFIRMATION_REQUIRED", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });

  ctx.advanceClock(5 * 60 * 1000 + 1);
  const expired = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 0);
});

test("draft send：收件人/主题在 confirm 前发生变化，实时摘要不符 E_CONFIRMATION_REQUIRED", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });

  // 直接在 mock 层修改 compose tab 的实时状态（模拟用户在 prepare 之后、
  // confirm 之前又编辑了收件人，且还没有再次保存）——confirm 必须重新读取
  // 实时 getComposeDetails，而不是信任 prepare 时的快照。
  ctx.browserWrite.setComposeDetailsDirectly(created.result.composeTabId, { to: ["mallory@example.com"] });

  const confirmed = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 0, "摘要不符必须在真正发送之前拦截");
});

test("draft send：draftRevision 与 prepare 时不符（客户端传错）E_CONFIRMATION_REQUIRED", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });

  const wrongRevision = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: "sha256:" + "0".repeat(64),
  });
  assert.equal(wrongRevision.ok, false);
  assert.equal(wrongRevision.errorCode, "E_CONFIRMATION_REQUIRED");
});

test("draft send：撰写窗口在 confirm 前关闭 E_CONFIRMATION_REQUIRED，不触发发送", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });
  ctx.browserWrite.closeTab(created.result.composeTabId);

  const confirmed = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 0);
});

test("draft send：sendMessage 真实失败时返回 E_INTERNAL 且 operations get 显示 failed", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });
  ctx.browserWrite.setSendShouldFail(true);

  const confirmed = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.errorCode, "E_INTERNAL");

  // 标题承诺了"operations get 显示 failed"，这里必须真的调用它验证，而不是
  // 只停在 confirm 本身的错误码上。operationId 目前只能从错误消息文本里
  // 提取（send.ts 没有结构化 details 通道，见其内部注释）——这个提取只用于
  // 测试内部验证"确实存在且状态正确"，不代表这个文本格式是稳定协议，真实
  // 调用方不应依赖这种解析方式。
  const operationIdMatch = /operationId=(op_[A-Za-z0-9_-]+)/.exec(confirmed.errorMessage);
  assert.ok(operationIdMatch, `错误消息应包含可解析的 operationId：${confirmed.errorMessage}`);
  const opsRes = await call("operations.get", { operationId: operationIdMatch[1] });
  assert.equal(opsRes.ok, true, JSON.stringify(opsRes));
  assert.equal(opsRes.result.state, "failed");
  assert.equal(opsRes.result.undoable, false);
});

// ---------------------------------------------------------------------------
// attachments save / fetch
// ---------------------------------------------------------------------------

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = i % 256;
  return bytes;
}

async function setupAttachment(ctx, call, size) {
  const nativeId = ctx.browserWrite.addMessage({});
  ctx.browserWrite.setAttachment(nativeId, { contentType: "application/pdf", name: "invoice.pdf", partName: "1.2", size }, randomBytes(size));
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages.at(-1).messageRef;
  const listRes = await call("attachments.list", { messageRef: msgRef });
  return listRes.result.attachments[0].attachmentRef;
}

test("attachments save：单块小附件一次拉取完成，digest 正确，token 一次性消费", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const attachmentRef = await setupAttachment(ctx, call, 1024);

  const saved = await call("attachments.save", { attachmentRef });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.result.size, 1024);
  assert.match(saved.result.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(saved.result.fetchToken, /^attachment_[A-Za-z0-9_-]{16,128}$/);

  const fetched = await call("attachments.fetch", { fetchToken: saved.result.fetchToken });
  assert.equal(fetched.ok, true, JSON.stringify(fetched));
  assert.equal(fetched.result.done, true);
  assert.equal(fetched.result.offset, 0);
  assert.equal(fetched.result.totalBytes, 1024);
  assert.equal(Buffer.from(fetched.result.chunkBase64, "base64").length, 1024);
  assert.equal("nextCursor" in fetched.result, false, "done=true 时不得出现 nextCursor");

  const secondFetch = await call("attachments.fetch", { fetchToken: saved.result.fetchToken });
  assert.equal(secondFetch.ok, false);
  assert.equal(secondFetch.errorCode, "E_NOT_FOUND", "已完整拉取的 token 必须一次性失效");
});

test("attachments fetch：跨越单块上限的附件产生多个 chunk，cursor 严格单调续取", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const RAW_CHUNK_BYTES = Math.floor((512 * 1024) / 4) * 3; // 393216，与 attachments-write.ts 一致
  const totalSize = RAW_CHUNK_BYTES + 12_345;
  const attachmentRef = await setupAttachment(ctx, call, totalSize);
  const saved = await call("attachments.save", { attachmentRef });

  const first = await call("attachments.fetch", { fetchToken: saved.result.fetchToken });
  assert.equal(first.ok, true);
  assert.equal(first.result.done, false);
  assert.equal(first.result.chunkBytes, RAW_CHUNK_BYTES);
  assert.ok(first.result.nextCursor);

  const second = await call("attachments.fetch", { fetchToken: saved.result.fetchToken, cursor: first.result.nextCursor });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.result.done, true);
  assert.equal(second.result.offset, RAW_CHUNK_BYTES);
  assert.equal(second.result.chunkBytes, totalSize - RAW_CHUNK_BYTES);

  // 重放第一段已经用过的 cursor：必须拒绝（一次性/严格单调）。
  const replay = await call("attachments.fetch", { fetchToken: saved.result.fetchToken, cursor: first.result.nextCursor });
  assert.equal(replay.ok, false);
  assert.equal(replay.errorCode, "E_NOT_FOUND");
});

test("attachments fetch：省略 cursor 但并非首段（乱序）E_VALIDATION", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const RAW_CHUNK_BYTES = Math.floor((512 * 1024) / 4) * 3;
  const attachmentRef = await setupAttachment(ctx, call, RAW_CHUNK_BYTES + 100);
  const saved = await call("attachments.save", { attachmentRef });
  await call("attachments.fetch", { fetchToken: saved.result.fetchToken });

  const outOfOrder = await call("attachments.fetch", { fetchToken: saved.result.fetchToken });
  assert.equal(outOfOrder.ok, false);
  assert.equal(outOfOrder.errorCode, "E_VALIDATION");
});

test("attachments save：原始大小超过 10MiB 上限直接拒绝，不签发 token", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const attachmentRef = await setupAttachment(ctx, call, 10 * 1024 * 1024 + 1);

  const saved = await call("attachments.save", { attachmentRef });
  assert.equal(saved.ok, false);
  assert.equal(saved.errorCode, "E_POLICY_DENIED");
});

test("attachments save：重新 save 同一附件作废旧 fetchToken", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const attachmentRef = await setupAttachment(ctx, call, 1024);

  const first = await call("attachments.save", { attachmentRef });
  const second = await call("attachments.save", { attachmentRef });
  assert.notEqual(first.result.fetchToken, second.result.fetchToken);

  const staleFetch = await call("attachments.fetch", { fetchToken: first.result.fetchToken });
  assert.equal(staleFetch.ok, false);
  assert.equal(staleFetch.errorCode, "E_NOT_FOUND");

  const freshFetch = await call("attachments.fetch", { fetchToken: second.result.fetchToken });
  assert.equal(freshFetch.ok, true, JSON.stringify(freshFetch));
});

test("attachments fetch：超过 2 分钟 TTL 后过期 E_NOT_FOUND", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const attachmentRef = await setupAttachment(ctx, call, 1024);
  const saved = await call("attachments.save", { attachmentRef });

  ctx.advanceClock(2 * 60 * 1000 + 1);
  const expired = await call("attachments.fetch", { fetchToken: saved.result.fetchToken });
  assert.equal(expired.ok, false);
  assert.equal(expired.errorCode, "E_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// 补充验收（team-lead/Opus 第三段判据）：跨 client confirmation、仅主题
// 变化触发摘要失效、operations get 不泄漏他人 operation、审计日志脱敏。
// ---------------------------------------------------------------------------

test("draft send：跨 client 提交 confirm 必须 E_CONFIRMATION_REQUIRED，不泄漏 confirmationId 是否存在", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });

  const crossClient = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  }, "client_B", "0");
  assert.equal(crossClient.ok, false);
  assert.equal(crossClient.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 0, "跨 client 的 confirm 绝不能触发真实发送");

  // 证明上面的拒绝不是 confirmationId 本身已经失效——原 client 仍能正常兑现。
  const legit = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  }, "client_A", "0");
  assert.equal(legit.ok, true, JSON.stringify(legit));
});

test("draft send：仅主题变化也会让 confirm 因摘要不符而失败", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });

  ctx.browserWrite.setComposeDetailsDirectly(created.result.composeTabId, { subject: "changed subject only" });
  const confirmed = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 0);
});

test("operations get：跨 client 查询他人 operation 必须 E_NOT_FOUND，不泄漏存在性", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({});
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;
  const marked = await call("messages.mark", { messageRefs: [msgRef], read: true });

  const crossClient = await call("operations.get", { operationId: marked.result.operationId }, "client_B", "0");
  assert.equal(crossClient.ok, false);
  assert.equal(crossClient.errorCode, "E_NOT_FOUND");

  const crossEpoch = await call("operations.get", { operationId: marked.result.operationId }, "client_A", "1");
  assert.equal(crossEpoch.ok, false);
  assert.equal(crossEpoch.errorCode, "E_NOT_FOUND");

  const legit = await call("operations.get", { operationId: marked.result.operationId }, "client_A", "0");
  assert.equal(legit.ok, true, JSON.stringify(legit));
});

test("audit 日志：mark 成功事件不含 token/正文/完整邮箱地址，client 只以 keyed hash 出现", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const secretClientId = "client_super_secret_identity_001";
  ctx.browserWrite.addMessage({});
  // msgRef 必须在 secretClientId 名下签发（ref 绑定 clientId），否则后面
  // mark 会因为跨 client 解析 ref 而先 E_NOT_FOUND，测不到审计日志内容。
  const searchRes = await call("messages.search", {}, secretClientId, "0");
  const msgRef = searchRes.result.messages[0].messageRef;

  ctx.consoleInfos.length = 0;
  const marked = await call("messages.mark", { messageRefs: [msgRef], read: true }, secretClientId, "0");
  assert.equal(marked.ok, true, JSON.stringify(marked));
  const undoToken = marked.result.undo.token;

  const auditLines = ctx.consoleInfos.filter((args) => String(args[0]).includes("[audit]")).map((args) => args.map(String).join(" "));
  assert.ok(auditLines.length > 0, "mark 成功必须产生至少一条审计日志");
  for (const line of auditLines) {
    assert.doesNotMatch(line, new RegExp(secretClientId), "审计日志不得包含原始 clientId 明文");
    assert.doesNotMatch(line, /read|flagged|junk|tags/i, "审计日志不得包含具体字段级正文/变更内容");
    assert.doesNotMatch(line, new RegExp(undoToken), "审计日志不得包含 undo token 明文");
    assert.doesNotMatch(line, /@example\.com/, "审计日志不得包含完整邮箱地址");
  }
  assert.ok(auditLines.some((line) => /client#[0-9a-f]{8}/.test(line)), "client 应以固定格式的 keyed hash 出现，而不是原始 id 或完全缺席");

  // Task #42：detail 自由文本已被移除，改为封闭 allowlist——这里正面验证
  // messages.mark 真实产出的是结构化 affectedCount 数值字段，而不是任何
  // 形式的自由文本 detail。
  const markAuditLine = JSON.parse(ctx.consoleInfos.filter((args) => String(args[0]).includes("[audit]") && String(args[1]).includes('"route":"messages.mark"'))[0][1]);
  assert.equal(markAuditLine.affectedCount, 1);
  assert.equal("detail" in markAuditLine, false, "audit 事件不应再存在自由文本 detail 字段");
});

test("audit 日志：draft send 全流程（含真实主题/收件人）不泄漏完整主题或收件人地址", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const secretSubject = "机密并购谈判进度速报-请勿外传";
  const secretRecipient = "very-secret-target@example.com";
  const identityRef = await setupIdentity(call);

  ctx.consoleInfos.length = 0;
  const created = await call("drafts.create", { identityRef, to: [secretRecipient], subject: secretSubject, body: "正文机密内容" });
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });
  const confirmed = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));

  const auditLines = ctx.consoleInfos.filter((args) => String(args[0]).includes("[audit]")).map((args) => args.map(String).join(" "));
  assert.ok(auditLines.length >= 3, "create/prepare/confirm 三步都应各自产生审计日志");
  for (const line of auditLines) {
    assert.doesNotMatch(line, new RegExp(secretSubject), "审计日志不得包含完整主题明文");
    assert.doesNotMatch(line, new RegExp(secretRecipient), "审计日志不得包含完整收件人地址明文");
    assert.doesNotMatch(line, /正文机密内容/, "审计日志不得包含正文明文");
    assert.doesNotMatch(line, new RegExp(prepared.result.confirmationId), "审计日志不得包含 confirmationId 明文");
    assert.doesNotMatch(line, /"detail"/, "Task #42 之后 audit 事件不应再出现自由文本 detail 字段");
  }
});

test("audit 日志：attachments save/fetch 真实产出结构化 sizeBytes/offsetBytes/done，不以字符串拼接形式出现", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const attachmentRef = await setupAttachment(ctx, call, 700 * 1024); // 跨越单块上限，产生两个 chunk

  ctx.consoleInfos.length = 0;
  const saved = await call("attachments.save", { attachmentRef });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const first = await call("attachments.fetch", { fetchToken: saved.result.fetchToken });
  assert.equal(first.result.done, false);
  const second = await call("attachments.fetch", { fetchToken: saved.result.fetchToken, cursor: first.result.nextCursor });
  assert.equal(second.result.done, true);

  const auditCalls = ctx.consoleInfos.filter((args) => String(args[0]).includes("[audit]"));
  const saveLine = auditCalls.map((c) => JSON.parse(c[1])).find((l) => l.route === "attachments.save");
  const fetchLines = auditCalls.map((c) => JSON.parse(c[1])).filter((l) => l.route === "attachments.fetch");

  assert.ok(saveLine, "attachments.save 必须产生审计日志");
  assert.equal(saveLine.sizeBytes, 700 * 1024, "sizeBytes 必须是真实附件字节数的数值字段，不是拼接字符串");
  assert.equal("detail" in saveLine, false);

  assert.equal(fetchLines.length, 2, "两次 fetch 各自产生一条审计日志");
  assert.equal(fetchLines[0].offsetBytes, 0);
  assert.equal(fetchLines[0].done, false);
  assert.equal(typeof fetchLines[0].done, "boolean", "done 必须是真正的 boolean，不是字符串 \"false\"");
  assert.equal(fetchLines[1].done, true);
  assert.ok(fetchLines[1].offsetBytes > 0);
  for (const line of [saveLine, ...fetchLines]) assert.equal("detail" in line, false);
});

test("audit 日志：messages.move 产生 affectedCount，operations.undo 产生 restoredCount，均为数值字段（不是字符串拼接）", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  ctx.browserWrite.addMessage({});
  ctx.browserWrite.addMessage({});
  const foldersRes = await call("folders.list", {});
  const archiveRef = foldersRes.result.folders.find((f) => f.name === "Archive").folderRef;
  const searchRes = await call("messages.search", {});
  const refs = searchRes.result.messages.map((m) => m.messageRef);

  ctx.consoleInfos.length = 0;
  const moved = await call("messages.move", { messageRefs: refs, targetFolderRef: archiveRef });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const undone = await call("operations.undo", { undoToken: moved.result.undo.token });
  assert.equal(undone.ok, true, JSON.stringify(undone));

  const auditLines = ctx.consoleInfos.filter((args) => String(args[0]).includes("[audit]")).map((args) => JSON.parse(args[1]));
  const moveLine = auditLines.find((l) => l.route === "messages.move");
  const undoLine = auditLines.find((l) => l.route === "operations.undo");
  assert.equal(moveLine.affectedCount, 2);
  assert.equal(undoLine.restoredCount, 2);
  assert.equal("detail" in moveLine, false);
  assert.equal("detail" in undoLine, false);
});

// ---------------------------------------------------------------------------
// 第二轮补充验收（team-lead/Opus 追加矩阵）：confirmation 跨 pairingEpoch、
// attachmentDigest/正文/identity 独立变化触发真实 revision 失效、
// nonce/本机路径永远无法进入 audit（用 schema 拒绝未知字段证明，而不是
// 空洞断言）。
// ---------------------------------------------------------------------------

test("draft send：跨 pairingEpoch 提交 confirm 必须 E_CONFIRMATION_REQUIRED，不消费合法 epoch 的 token", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });

  const crossEpoch = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  }, "client_A", "1");
  assert.equal(crossEpoch.ok, false);
  assert.equal(crossEpoch.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 0, "跨 epoch 的 confirm 绝不能触发真实发送");

  // 证明上面的拒绝不是 confirmationId 本身已经失效——同 client 同 epoch=0 仍能正常兑现。
  const legit = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  }, "client_A", "0");
  assert.equal(legit.ok, true, JSON.stringify(legit));
  assert.equal(ctx.browserWrite.sendAttempts.length, 1);
});

test("draft send：仅附件变化（attachmentDigest 不符）独立触发 confirm 失效，收件人/主题/正文均未变", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });
  assert.match(prepared.result.attachmentDigest, /^sha256:[0-9a-f]{64}$/, "无附件时 attachmentDigest 仍应是一个格式合法的固定摘要");
  const originalAttachmentDigest = prepared.result.attachmentDigest;

  // 只改 attachments，不碰 to/subject/body——证明 attachmentDigest 是独立
  // 被计算并校验的一路，不是靠 recipientDigest/subjectDigest 顺带覆盖到。
  ctx.browserWrite.setComposeDetailsDirectly(created.result.composeTabId, { attachments: [{ name: "sneaky.pdf", size: 1 }] });
  const confirmed = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 0);

  // 直接证明摘要值本身变了（而不只是"confirm 因为某种原因失败了"）：重新
  // prepare 一次，新的 attachmentDigest 必须与改附件前不同。
  const reprepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });
  assert.notEqual(reprepared.result.attachmentDigest, originalAttachmentDigest, "attachments 变化后重新计算的 attachmentDigest 必须不同");
  assert.equal(reprepared.result.recipientDigest, prepared.result.recipientDigest, "收件人未变，recipientDigest 应保持一致");
  assert.equal(reprepared.result.subjectDigest, prepared.result.subjectDigest, "主题未变，subjectDigest 应保持一致");
});

test("draft send：仅正文变化独立触发 revision 不符，收件人/主题/附件均未变", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });

  ctx.browserWrite.setComposeDetailsDirectly(created.result.composeTabId, { body: "偷偷改过的正文，与 prepare 时不一致" });
  const confirmed = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 0);
});

test("draft send：仅 identity 变化独立触发 revision 不符，收件人/主题/正文/附件均未变", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const created = await createDraftForSend(call);
  const prepared = await call("drafts.send.prepare", { draftRef: created.result.draftRef });

  ctx.browserWrite.setComposeDetailsDirectly(created.result.composeTabId, { identityId: "id-different-identity" });
  const confirmed = await call("drafts.send.confirm", {
    draftRef: created.result.draftRef, confirmationId: prepared.result.confirmationId, draftRevision: prepared.result.revision,
  });
  assert.equal(confirmed.ok, false);
  assert.equal(confirmed.errorCode, "E_CONFIRMATION_REQUIRED");
  assert.equal(ctx.browserWrite.sendAttempts.length, 0);
  // recipientDigest/subjectDigest/attachmentDigest 均未变，只有整体 revision
  // 变了——证明 identityId 确实被纳入 revision 摘要输入。
});

// Task #42 收敛：下面这条测试只证明 schema 层挡住了畸形请求（请求根本没
// 走到 handler，更没走到 recordAudit()），对"audit sink 本身是否会把任意
// 属性原样吐出去"这件事是空洞的——sink 在这条测试里从未被真正调用过一次。
// 那部分真正的证明（绕过所有上游校验，直接向 recordAudit() 强塞
// detail/nonce/path/subject/body/address/token 等 canary）在
// test/audit.test.mjs 里独立覆盖。这里保留是因为"扩展不接收也不校验任何
// 本机文件系统路径"这条契约本身仍然值得在真实 bundle 上跑一次端到端验证。
test("schema 层拒绝携带 nonce/本机路径的畸形请求（不构成 audit sink 本身不泄漏的证明，见 test/audit.test.mjs）", async () => {
  const bundle = await getBundle();
  const ctx = await loadBundleInSandbox(bundle);
  const call = makeCaller(ctx.getOperationListener(), ctx.responded, ctx.failed);
  const canaryNonce = "canary-nonce-9f1e7c2b4a";
  const canaryPath = "/Users/victim/.ssh/id_ed25519-canary-path";

  ctx.browserWrite.addMessage({});
  const searchRes = await call("messages.search", {});
  const msgRef = searchRes.result.messages[0].messageRef;

  ctx.consoleInfos.length = 0;
  ctx.consoleErrors.length = 0;

  // attachments.save 的冻结契约只接受 attachmentRef 一个字段（team-lead/Opus
  // 裁决："扩展不接收也不校验任何本机文件系统路径"）——伪装一个 path/directory
  // 字段必须在 schema 层被当成未知字段拒绝，请求根本不会到达
  // attachmentsSave() 内部，更不可能被 recordAudit() 记录下来。
  const withPath = await call("attachments.save", { attachmentRef: "attachment_0000000000000000", path: canaryPath, directory: canaryPath });
  assert.equal(withPath.ok, false);
  assert.equal(withPath.errorCode, "E_VALIDATION");

  // drafts.create 的 schema 同样只接受固定字段集合，伪装一个 nonce 字段必须
  // 被当成未知字段拒绝，同样不会进入 draftsCreate() 内部。
  const identityRef = await setupIdentity(call);
  const withNonce = await call("drafts.create", { identityRef, subject: "x", nonce: canaryNonce });
  assert.equal(withNonce.ok, false);
  assert.equal(withNonce.errorCode, "E_VALIDATION");

  const allLines = [...ctx.consoleInfos, ...ctx.consoleErrors].map((args) => args.map(String).join(" "));
  assert.equal(allLines.length, 0, "两次请求都应在 schema 校验阶段被拒绝，不产生任何 console 输出（包括审计日志）");
  for (const line of allLines) {
    assert.doesNotMatch(line, new RegExp(canaryNonce));
    assert.doesNotMatch(line, new RegExp(canaryPath.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
