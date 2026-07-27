// extension/src/options.ts（编译产物 extension/dist/options.js）的执行级测试。
// options.js 是普通 `<script type="module">`，运行在标准网页 DOM 环境，不
// 依赖任何 XPCOM/Experiment 全局——用一个极简的手写 DOM/browser mock 直接在
// 当前 Node 进程的 globalThis 上跑，而不是像 api.js/background.js 那样需要
// vm 隔离出一个带 Cc/Ci 的特权作用域。
//
// 每个测试都用带自增计数器的 query string 重新 import 同一份 dist/options.js
// （Node 按 URL 精确匹配缓存 ES 模块），确保每个测试拿到全新的顶层状态
// （事件监听器、displayedIntent 闭包变量），不会被其它测试的 DOM mock 污染。
import assert from "node:assert/strict";
import { test } from "node:test";

let importCounter = 0;

function makeElement(overrides = {}) {
  return { textContent: "", disabled: false, ...overrides };
}

function makeCheckbox(value) {
  return { type: "checkbox", value, checked: false, disabled: true };
}

const CAPABILITY_VALUES = ["mail.read.v1", "mail.reversible.v1", "draft.write.v1", "mail.send-confirmed.v1"];

function createFixture() {
  const elements = {
    "#service-state": makeElement(),
    "#pairing-state": makeElement(),
    "#client-id": makeElement(),
    "#pairing-code": makeElement(),
    "#confirm-pairing": makeElement({ addEventListener(type, handler) { this._listeners = { ...this._listeners, [type]: handler }; } }),
    "#revoke-pairing": makeElement({ addEventListener(type, handler) { this._listeners = { ...this._listeners, [type]: handler }; } }),
    "#apply-capabilities": makeElement(),
    "#capabilities-status": makeElement(),
  };
  const checkboxes = Object.fromEntries(CAPABILITY_VALUES.map((value) => [value, makeCheckbox(value)]));
  let formSubmitHandler;
  const form = {
    addEventListener(type, handler) { if (type === "submit") formSubmitHandler = handler; },
    querySelector(selector) {
      const match = /value="([^"]+)"/.exec(selector);
      return match ? (checkboxes[match[1]] ?? null) : null;
    },
  };
  elements["#capabilities-form"] = form;

  const document = { querySelector: (selector) => elements[selector] ?? null };
  const calls = { confirmPairing: [], revokePairing: [], setMailCapabilities: [] };
  let getStateImpl = async () => baseState();

  function baseState(overrides = {}) {
    return {
      serviceStarted: true, port: 49_152, descriptorPath: "/tmp/x", instanceId: "inst_x", profileId: `sha256:${"0".repeat(64)}`,
      pairingState: "unpaired", pairingEpoch: "0", clientId: null, capabilities: [],
      pendingIntentId: null, pendingCode: null, pendingClientId: null, pendingExpiresAt: null, error: null,
      ...overrides,
    };
  }

  const browser = {
    thunderbirdSkillBridge: {
      getState: async () => getStateImpl(),
      confirmPairing: async (intentId, code) => { calls.confirmPairing.push({ intentId, code }); return baseState({ pairingState: "paired", clientId: "client_demo" }); },
      revokePairing: async () => { calls.revokePairing.push(true); return baseState({ pairingState: "revoked" }); },
      setMailCapabilities: async (capabilities) => { calls.setMailCapabilities.push(capabilities); return baseState({ pairingState: "paired", clientId: "client_demo", capabilities }); },
    },
  };

  return {
    elements, form, checkboxes, document, browser, calls,
    setGetState(impl) { getStateImpl = impl; },
    baseState,
    submitCapabilitiesForm: async () => { await formSubmitHandler?.({ preventDefault() {} }); },
  };
}

async function loadOptions(fixture) {
  globalThis.document = fixture.document;
  globalThis.browser = fixture.browser;
  globalThis.CSS = { escape: (value) => value };
  importCounter += 1;
  await import(`../extension/dist/options.js?t=${importCounter}`);
  // refresh() 里的 await browser.thunderbirdSkillBridge.getState() 需要一轮事件循环才能把渲染结果写回 DOM。
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("未配对时：能力复选框全部禁用且未勾选，保存按钮禁用", async () => {
  const fixture = createFixture();
  await loadOptions(fixture);
  for (const value of CAPABILITY_VALUES) {
    assert.equal(fixture.checkboxes[value].disabled, true, value);
    assert.equal(fixture.checkboxes[value].checked, false, value);
  }
  assert.equal(fixture.elements["#apply-capabilities"].disabled, true);
  assert.equal(fixture.elements["#capabilities-status"].textContent, "未配对，无法授予能力");
});

test("已配对且已有 capabilities 时：对应复选框预填勾选、可交互", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: ["mail.read.v1", "draft.write.v1"] }));
  await loadOptions(fixture);
  assert.equal(fixture.checkboxes["mail.read.v1"].checked, true);
  assert.equal(fixture.checkboxes["draft.write.v1"].checked, true);
  assert.equal(fixture.checkboxes["mail.reversible.v1"].checked, false);
  assert.equal(fixture.checkboxes["mail.send-confirmed.v1"].checked, false);
  for (const value of CAPABILITY_VALUES) assert.equal(fixture.checkboxes[value].disabled, false, value);
  assert.equal(fixture.elements["#apply-capabilities"].disabled, false);
});

test("提交表单：覆盖式调用 setMailCapabilities，只传勾选中的能力", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: [] }));
  await loadOptions(fixture);

  fixture.checkboxes["mail.read.v1"].checked = true;
  fixture.checkboxes["mail.reversible.v1"].checked = true;
  fixture.checkboxes["draft.write.v1"].checked = false;
  fixture.checkboxes["mail.send-confirmed.v1"].checked = false;
  await fixture.submitCapabilitiesForm();

  assert.equal(fixture.calls.setMailCapabilities.length, 1);
  assert.deepEqual([...fixture.calls.setMailCapabilities[0]].sort(), ["mail.read.v1", "mail.reversible.v1"]);
  assert.match(fixture.elements["#capabilities-status"].textContent, /已保存，当前授予 2 项能力/);
});

test("提交表单：全部取消勾选时覆盖式清空，状态文案明确提示邮件 route 将失败关闭", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: ["mail.read.v1"] }));
  await loadOptions(fixture);

  fixture.checkboxes["mail.read.v1"].checked = false;
  await fixture.submitCapabilitiesForm();

  assert.deepEqual(fixture.calls.setMailCapabilities[0], []);
  assert.match(fixture.elements["#capabilities-status"].textContent, /未授予任何能力/);
});

test("提交表单失败时：展示错误信息并回退到真实的最新状态，不假设已生效", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: ["mail.read.v1"] }));
  await loadOptions(fixture);

  fixture.browser.thunderbirdSkillBridge.setMailCapabilities = async () => { throw new Error("模拟保存失败"); };
  fixture.checkboxes["draft.write.v1"].checked = true;
  await fixture.submitCapabilitiesForm();

  assert.match(fixture.elements["#capabilities-status"].textContent, /保存失败：模拟保存失败/);
  // 回退调用了 getState()，用真实（未被本次失败提交污染）的 capabilities 重新渲染。
  assert.equal(fixture.checkboxes["mail.read.v1"].checked, true);
  assert.equal(fixture.checkboxes["draft.write.v1"].checked, false);
});

test("确认配对：intentId/code/clientId 三者必须与当前实际状态完全匹配才提交", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pendingIntentId: "intent_abc", pendingCode: "123456", pendingClientId: "client_demo" }));
  await loadOptions(fixture);
  assert.equal(fixture.elements["#confirm-pairing"].disabled, false);

  await fixture.elements["#confirm-pairing"]._listeners.click({});
  assert.equal(fixture.calls.confirmPairing.length, 1);
  assert.deepEqual(fixture.calls.confirmPairing[0], { intentId: "intent_abc", code: "123456" });
});

test("撤销配对按钮仅在 paired 状态下可用", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo" }));
  await loadOptions(fixture);
  assert.equal(fixture.elements["#revoke-pairing"].disabled, false);
  await fixture.elements["#revoke-pairing"]._listeners.click({});
  assert.equal(fixture.calls.revokePairing.length, 1);
});
