// 纯单元测试：extension/src/audit.ts 编译产物（extension/dist/audit.js）。
// 不依赖任何 XPCOM/Experiment 夹具、不经过 vm/bundle——直接对 recordAudit()
// 这个 sink 函数本身下手。
//
// 存在意义（Task #42）：3eeace7 之前唯一的"审计不泄漏敏感信息"证据是
// test/mail-write-integration.test.mjs 里一条通过 schema 拒绝畸形请求、
// 断言"零审计日志"的测试——那只证明了 schema 层挡住了畸形请求，完全没有
// 触达 recordAudit() 内部，对 sink 本身是否会把任意属性原样吐出去这件事
// 是空洞的（sink 从未被真正调用过一次）。
//
// 这里反过来：绕过所有上游 schema/handler，直接、故意地用
// `as unknown as AuditEvent` 把 detail/nonce/path/subject/body/address/
// token 等 canary 字段和非法 reason/畸形数字塞进 recordAudit()，证明 sink
// 内部的手工 allowlist 拷贝逻辑本身——而不是上游某一层校验——才是不泄漏的
// 根本原因。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("..", import.meta.url).pathname;

let recordAudit;
let auditModule;
let outDir;
let auditJsPath;

before(async () => {
  // 独立编译到临时目录，不读写共享的 extension/dist/——同样的隔离策略见
  // test/bundle.test.mjs、test/mail-write-integration.test.mjs 头部注释。
  outDir = await mkdtemp(join(tmpdir(), "tb-audit-test-"));
  await execFileAsync(process.execPath, [
    join(projectRoot, "node_modules/typescript/bin/tsc"),
    "-p", join(projectRoot, "extension/tsconfig.json"),
    "--outDir", outDir,
  ]);
  auditJsPath = join(outDir, "audit.js");
  auditModule = await import(`file://${auditJsPath}?t=${Date.now()}`);
  ({ recordAudit } = auditModule);
});

after(async () => {
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

/**
 * `extension/src/audit.ts` 在 AUDIT_HASH_KEY 上没有任何 import——把编译产物
 * 复制成一个不同的文件路径再 `import()`，ESM 模块缓存按 URL 区分，会得到
 * 一份独立的模块实例，其顶层 `crypto.getRandomValues(AUDIT_HASH_KEY)` 会
 * 重新执行一次，产出与原模块不同的私有 key——这模拟的正是"进程重启后
 * 重新加载模块"的场景，不需要真的开另一个进程。
 */
async function importFreshAuditModule() {
  const freshPath = join(outDir, `audit-fresh-${Math.random().toString(36).slice(2)}.js`);
  await copyFile(auditJsPath, freshPath);
  return import(`file://${freshPath}?t=${Date.now()}`);
}

/** 劫持 console.info/console.error，返回捕获的调用与一个恢复函数。 */
function captureConsole() {
  const infos = [];
  const errors = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...args) => infos.push(args);
  console.error = (...args) => errors.push(args);
  return {
    infos,
    errors,
    restore() {
      console.info = originalInfo;
      console.error = originalError;
    },
  };
}

/** 捕获的调用形如 ["[thunderbird-skill-bridge][audit]", jsonString]；解析出 line 对象。 */
function parseLine(call) {
  return JSON.parse(call[1]);
}

const CANARIES = {
  detail: "canary-detail-should-never-appear",
  nonce: "canary-nonce-9f1e7c2b4a",
  path: "/Users/victim/.ssh/id_ed25519-canary-path",
  subject: "canary-secret-subject-并购谈判",
  body: "canary-secret-body-正文机密内容",
  address: "canary-target@example.com",
  token: "tok_canary_should_never_leak_1234567890",
};

test("recordAudit：合法调用只输出 route/capability/client(hash)/outcome，不含 clientId 明文", () => {
  const cap = captureConsole();
  try {
    recordAudit({ routeId: "messages.mark", capability: "mail.reversible.v1", clientId: "client_super_secret_001", outcome: "success" });
  } finally {
    cap.restore();
  }
  assert.equal(cap.infos.length, 1);
  const line = parseLine(cap.infos[0]);
  assert.equal(line.route, "messages.mark");
  assert.equal(line.capability, "mail.reversible.v1");
  assert.match(line.client, /^client#[0-9a-f]{16}$/);
  assert.equal(line.outcome, "success");
  assert.equal("reason" in line, false);
  assert.doesNotMatch(JSON.stringify(line), /client_super_secret_001/);
});

test("recordAudit：outcome=error 走 console.error，success/denied 走 console.info", () => {
  const cap = captureConsole();
  try {
    recordAudit({ routeId: "drafts.send.confirm", capability: "mail.send-confirmed.v1", clientId: "c1", outcome: "error", reason: "send-failed" });
    recordAudit({ routeId: "drafts.send.confirm", capability: "mail.send-confirmed.v1", clientId: "c1", outcome: "denied", reason: "revision-mismatch" });
    recordAudit({ routeId: "messages.mark", capability: "mail.reversible.v1", clientId: "c1", outcome: "success" });
  } finally {
    cap.restore();
  }
  assert.equal(cap.errors.length, 1);
  assert.equal(cap.infos.length, 2);
  assert.equal(parseLine(cap.errors[0]).reason, "send-failed");
});

test("recordAudit：全部 10 个合法 AuditReason 枚举值都被保留", () => {
  const reasons = [
    "too-large", "too-large-actual", "reused-tab", "reopened-from-template",
    "confirm-not-found", "revision-mismatch", "tab-closed", "live-digest-mismatch", "send-failed",
    "send-permission-missing",
  ];
  const cap = captureConsole();
  try {
    for (const reason of reasons) {
      recordAudit({ routeId: "x", capability: "mail.reversible.v1", clientId: "c1", outcome: "denied", reason });
    }
  } finally {
    cap.restore();
  }
  const seen = cap.infos.map((call) => parseLine(call).reason);
  assert.deepEqual(seen, reasons);
});

test("recordAudit：合法数值/布尔 allowlist 字段（affectedCount/restoredCount/sizeBytes/offsetBytes/done）原样保留", () => {
  const cap = captureConsole();
  try {
    recordAudit({ routeId: "messages.mark", capability: "mail.reversible.v1", clientId: "c1", outcome: "success", affectedCount: 3 });
    recordAudit({ routeId: "operations.undo", capability: "mail.reversible.v1", clientId: "c1", outcome: "success", restoredCount: 2 });
    recordAudit({ routeId: "attachments.save", capability: "mail.reversible.v1", clientId: "c1", outcome: "success", sizeBytes: 123456 });
    recordAudit({ routeId: "attachments.fetch", capability: "mail.reversible.v1", clientId: "c1", outcome: "success", offsetBytes: 0, done: false });
    recordAudit({ routeId: "attachments.fetch", capability: "mail.reversible.v1", clientId: "c1", outcome: "success", offsetBytes: 524288, done: true });
  } finally {
    cap.restore();
  }
  const lines = cap.infos.map(parseLine);
  assert.equal(lines[0].affectedCount, 3);
  assert.equal(lines[1].restoredCount, 2);
  assert.equal(lines[2].sizeBytes, 123456);
  assert.equal(lines[3].offsetBytes, 0);
  assert.equal(lines[3].done, false);
  assert.equal(lines[4].offsetBytes, 524288);
  assert.equal(lines[4].done, true);
});

test("recordAudit：直接向 sink 强塞 detail/nonce/path/subject/body/address/token canary（绕过所有上游 schema/handler），全部字段一律不出现在输出里", () => {
  const cap = captureConsole();
  try {
    // as unknown as AuditEvent 的运行时等价物：普通 JS 对象，编译期类型系统
    // 管不到这里——这正是要验证的场景（调用方即使手滑/被篡改，sink 本身
    // 仍然不会把它们序列化出去）。
    recordAudit({
      routeId: "attachments.save",
      capability: "mail.reversible.v1",
      clientId: "client_should_be_hashed",
      outcome: "success",
      reason: "too-large",
      ...CANARIES,
    });
  } finally {
    cap.restore();
  }
  assert.equal(cap.infos.length, 1);
  const raw = cap.infos[0][1];
  const line = JSON.parse(raw);
  for (const [key, value] of Object.entries(CANARIES)) {
    assert.equal(key in line, false, `line 不应包含字段 ${key}`);
    assert.doesNotMatch(raw, new RegExp(value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")), `line 原始 JSON 文本不应包含 canary 值 "${value}"`);
  }
  // 合法字段（reason）必须仍然正常输出——证明不是"整个事件都被吞掉了"，
  // 而是精确地只丢弃 allowlist 之外的属性。
  assert.equal(line.reason, "too-large");
  assert.doesNotMatch(raw, /client_should_be_hashed/);
});

test("recordAudit：非法 reason（不在枚举内的字符串）被丢弃，不出现在输出里", () => {
  const cap = captureConsole();
  try {
    recordAudit({ routeId: "x", capability: "mail.reversible.v1", clientId: "c1", outcome: "denied", reason: "not-a-real-reason-injected" });
  } finally {
    cap.restore();
  }
  const line = parseLine(cap.infos[0]);
  assert.equal("reason" in line, false);
  assert.doesNotMatch(cap.infos[0][1], /not-a-real-reason-injected/);
});

test("recordAudit：畸形数字（负数/非整数/NaN/Infinity/字符串数字）一律丢弃对应字段，不以奇怪形式泄漏", () => {
  const malformed = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "3", null, undefined, {}, []];
  const cap = captureConsole();
  try {
    for (const value of malformed) {
      recordAudit({ routeId: "messages.mark", capability: "mail.reversible.v1", clientId: "c1", outcome: "success", affectedCount: value });
    }
  } finally {
    cap.restore();
  }
  for (const call of cap.infos) {
    const line = parseLine(call);
    assert.equal("affectedCount" in line, false, `畸形值不应产生 affectedCount 字段：${call[1]}`);
  }
});

test("recordAudit：done 字段只接受真正的 boolean，字符串 \"true\"/数字 1 不被当作合法值", () => {
  const cap = captureConsole();
  try {
    recordAudit({ routeId: "attachments.fetch", capability: "mail.reversible.v1", clientId: "c1", outcome: "success", done: "true" });
    recordAudit({ routeId: "attachments.fetch", capability: "mail.reversible.v1", clientId: "c1", outcome: "success", done: 1 });
    recordAudit({ routeId: "attachments.fetch", capability: "mail.reversible.v1", clientId: "c1", outcome: "success", done: true });
  } finally {
    cap.restore();
  }
  const lines = cap.infos.map(parseLine);
  assert.equal("done" in lines[0], false);
  assert.equal("done" in lines[1], false);
  assert.equal(lines[2].done, true);
});

test("recordAudit：同一个 clientId 每次都映射到相同的 keyed hash，不同 clientId 映射到不同 hash（可关联同一 client 的多条日志，但不暴露原始 id）", () => {
  const cap = captureConsole();
  try {
    recordAudit({ routeId: "x", capability: "mail.reversible.v1", clientId: "client_alpha", outcome: "success" });
    recordAudit({ routeId: "x", capability: "mail.reversible.v1", clientId: "client_alpha", outcome: "success" });
    recordAudit({ routeId: "x", capability: "mail.reversible.v1", clientId: "client_beta", outcome: "success" });
  } finally {
    cap.restore();
  }
  const [a1, a2, b1] = cap.infos.map(parseLine);
  assert.equal(a1.client, a2.client);
  assert.notEqual(a1.client, b1.client);
});

// ---------------------------------------------------------------------------
// keyed hash 的"keyed"部分：不是"同一输入稳定映射到同一摘要"就够了（裸
// FNV-1a 也满足这一点，但外部知道 clientId 明文就能自己重算、逐条比对
// 日志反查身份）。这里验证的是"没有这个进程私有 key 就无法重算"——通过
// 模拟"进程重启"（重新 import 一份独立编译的模块，触发一次新的
// crypto.getRandomValues）来证明同一个 clientId 在不同 key 下产出不同
// hash，而不是一个固定的、可公开重算的函数。
// ---------------------------------------------------------------------------

test("hashClientId 是真正的 keyed hash：模拟进程重启（重新加载模块）后，同一个 clientId 的 hash 大概率改变", async () => {
  const fresh = await importFreshAuditModule();

  const capBefore = captureConsole();
  let beforeLine;
  try {
    recordAudit({ routeId: "x", capability: "mail.reversible.v1", clientId: "same_client_across_restart", outcome: "success" });
    beforeLine = parseLine(capBefore.infos[0]);
  } finally {
    capBefore.restore();
  }

  const capAfter = captureConsole();
  let afterLine;
  try {
    fresh.recordAudit({ routeId: "x", capability: "mail.reversible.v1", clientId: "same_client_across_restart", outcome: "success" });
    afterLine = parseLine(capAfter.infos[0]);
  } finally {
    capAfter.restore();
  }

  // 128 bit key 空间下两次独立随机抽样撞出同一对 32-bit 累加器初值的概率
  // 可忽略不计；如果这条断言失败，说明 hashClientId 事实上没有真正依赖
  // AUDIT_HASH_KEY（例如 key 混入代码被误删/短路），退化回了裸 FNV-1a。
  assert.notEqual(beforeLine.client, afterLine.client, "同一 clientId 在两个独立加载的模块实例（不同随机 key）下必须产出不同的 hash，否则 key 没有真正参与运算");
});

test("hashClientId 的私有 key 从不通过模块导出面暴露：编译产物的运行时导出集合里只有 recordAudit", async () => {
  // audit.ts 里 AuditOutcome/AuditReason/AuditEvent 都是 `export type`/
  // `export interface`——纯类型声明，tsc 编译后完全擦除，不会产生任何
  // 运行时绑定；AUDIT_HASH_KEY 本身是模块作用域的 `const`，从未 `export`。
  // 直接断言编译产物的运行时导出面，防止未来有人为了"方便调试"顺手把
  // AUDIT_HASH_KEY 或 hashClientId 导出，从而让 key 变得可从模块外部读取。
  assert.deepEqual(Object.keys(auditModule).sort(), ["recordAudit"]);
});
