// 纯单元测试：extension/src/mail/state.ts 编译产物（extension/dist/mail/
// state.js）里 MailAdapterError 的结构化 details allowlist（Task #43）。
// 不依赖任何 XPCOM/Experiment 夹具、不经过 vm/bundle——同 test/audit.test.mjs
// 的思路，直接对构造函数本身下手，绕过所有业务 handler。
//
// 这是三层 allowlist 校验中最里面的一层：MailAdapterError 构造时（state.ts）
// →background.ts 的 extractErrorDetails（第二层，见 test/mail-write-
// integration.test.mjs 的 send-failed 用例间接覆盖）→api.js 的
// sanitizeMailErrorDetails（第三层，独立实现，见 test/mail-operations.test.mjs）。
// 三层各自独立校验、互不信任对方已经做对——这里只测最内层。
import assert from "node:assert/strict";
import { test } from "node:test";
import { MailAdapterError } from "../extension/dist/mail/state.js";

test("MailAdapterError：不传 details 时 details 是 undefined，不会凭空产生空对象", () => {
  const error = new MailAdapterError("E_INTERNAL", "内部错误");
  assert.equal(error.details, undefined);
});

test("MailAdapterError：合法的 op_ 前缀 operationId 被保留", () => {
  const opId = `op_${"a".repeat(16)}`;
  const error = new MailAdapterError("E_INTERNAL", "外发失败", { operationId: opId });
  assert.deepEqual(error.details, { operationId: opId });
});

test("MailAdapterError：格式不合法的 operationId（不是 op_ 前缀/太短/含非法字符）被丢弃，details 变回 undefined", () => {
  const badValues = ["not-an-op-id", "op_short", "acc_wrongkind0000000000", "op_" + "!".repeat(20), "", "op_" + "a".repeat(200)];
  for (const bad of badValues) {
    const error = new MailAdapterError("E_INTERNAL", "外发失败", { operationId: bad });
    assert.equal(error.details, undefined, `不合法值应被整体丢弃：${JSON.stringify(bad)}`);
  }
});

test("MailAdapterError：operationId 不是字符串类型（数字/对象/数组/null）时被丢弃", () => {
  const badTypes = [12345, { nested: "object" }, ["array"], null];
  for (const bad of badTypes) {
    // 绕过 TypeScript 类型标注，模拟运行时可能出现的畸形调用（与 test/audit.test.mjs
    // 对 recordAudit 的攻击方式同一原则：不信任调用方的编译期类型）。
    const error = new MailAdapterError("E_INTERNAL", "外发失败", { operationId: bad });
    assert.equal(error.details, undefined, `非字符串类型应被丢弃：${JSON.stringify(bad)}`);
  }
});

test("MailAdapterError：details 上 allowlist 之外的属性（即使是运行时强塞的）永远不会出现在 error.details 里", () => {
  const opId = `op_${"b".repeat(16)}`;
  // 运行时对象携带 canary 字段——TypeScript 的 MailErrorDetails 类型不包含
  // 它们，但构造函数不能假设运行时输入一定符合类型标注。
  const malicious = { operationId: opId, token: "tok_secret_leak", nonce: "canary-nonce", path: "/etc/passwd", subject: "机密主题", body: "机密正文" };
  const error = new MailAdapterError("E_INTERNAL", "外发失败", malicious);
  assert.deepEqual(error.details, { operationId: opId }, "只应保留 operationId，其余字段一律不出现");
  assert.equal(JSON.stringify(error.details).includes("secret"), false);
  assert.equal(JSON.stringify(error.details).includes("canary"), false);
  assert.equal(JSON.stringify(error.details).includes("etc/passwd"), false);
  assert.equal(JSON.stringify(error.details).includes("机密"), false);
});

test("MailAdapterError：code/message/name 字段不受 details 变化影响", () => {
  const error = new MailAdapterError("E_CONFIRMATION_REQUIRED", "草稿已变化", { operationId: `op_${"c".repeat(16)}` });
  assert.equal(error.code, "E_CONFIRMATION_REQUIRED");
  assert.equal(error.message, "草稿已变化");
  assert.equal(error.name, "MailAdapterError");
  assert.ok(error instanceof Error);
});
