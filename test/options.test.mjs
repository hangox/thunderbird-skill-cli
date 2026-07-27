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
  const calls = { confirmPairing: [], revokePairing: [], setMailCapabilities: [], permissionsRequest: [], permissionsRemove: [] };
  let getStateImpl = async () => baseState();

  function baseState(overrides = {}) {
    return {
      serviceStarted: true, port: 49_152, descriptorPath: "/tmp/x", instanceId: "inst_x", profileId: `sha256:${"0".repeat(64)}`,
      pairingState: "unpaired", pairingEpoch: "0", clientId: null, capabilities: [],
      pendingIntentId: null, pendingCode: null, pendingClientId: null, pendingExpiresAt: null, error: null,
      ...overrides,
    };
  }

  // Task #44/#45：compose.send 是可选权限，这里模拟一份真实的浏览器权限
  // 存储状态（`permissionGranted`），而不是让 request()/contains() 各自
  // 返回互不相关的值——这样才能真实覆盖"提交前已经持有 vs 这次提交才新
  // 拿到"的区别（Task #45 的回滚逻辑正是依赖这个区分）：
  // - contains() 如实反映当前持有状态。
  // - request()：已持有时（真实浏览器行为）直接返回 true、不弹窗；未持有
  //   时才真的"询问"用户（`nextRequestDecision`，由测试用例通过
  //   setPermissionRequestResult 设置，模拟用户在原生弹窗里的选择），并把
  //   持有状态更新为该选择结果。
  // - remove() 把持有状态清空。
  let permissionGranted = false;
  let nextRequestDecision = true;
  const browser = {
    thunderbirdSkillBridge: {
      getState: async () => getStateImpl(),
      confirmPairing: async (intentId, code) => { calls.confirmPairing.push({ intentId, code }); return baseState({ pairingState: "paired", clientId: "client_demo" }); },
      revokePairing: async () => { calls.revokePairing.push(true); return baseState({ pairingState: "revoked" }); },
      setMailCapabilities: async (capabilities) => { calls.setMailCapabilities.push(capabilities); return baseState({ pairingState: "paired", clientId: "client_demo", capabilities }); },
    },
    permissions: {
      request: async (request) => {
        calls.permissionsRequest.push(request);
        if (permissionGranted) return true;
        permissionGranted = nextRequestDecision;
        return permissionGranted;
      },
      remove: async (request) => { calls.permissionsRemove.push(request); permissionGranted = false; return true; },
      contains: async () => permissionGranted,
    },
  };

  return {
    elements, form, checkboxes, document, browser, calls,
    setGetState(impl) { getStateImpl = impl; },
    setPermissionRequestResult(value) { nextRequestDecision = value; },
    setPermissionGrantedBaseline(value) { permissionGranted = value; },
    isPermissionGranted: () => permissionGranted,
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

test("Task #44：勾选外发确认能力并提交时，先请求 compose.send 浏览器权限；同意后正常写入 capabilities", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: [] }));
  await loadOptions(fixture);
  fixture.setPermissionRequestResult(true);

  fixture.checkboxes["mail.send-confirmed.v1"].checked = true;
  await fixture.submitCapabilitiesForm();

  assert.equal(fixture.calls.permissionsRequest.length, 1);
  assert.deepEqual(fixture.calls.permissionsRequest[0], { permissions: ["compose.send"] });
  assert.equal(fixture.calls.permissionsRemove.length, 0, "同意授权时不应该调用 remove");
  assert.deepEqual(fixture.calls.setMailCapabilities[0], ["mail.send-confirmed.v1"]);
  assert.match(fixture.elements["#capabilities-status"].textContent, /已保存，当前授予 1 项能力/);
});

test("Task #44：浏览器拒绝 compose.send 权限请求时，外发确认能力不写入 capabilities、复选框回退为未勾选，其余勾选项仍正常保存", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: [] }));
  await loadOptions(fixture);
  fixture.setPermissionRequestResult(false);

  fixture.checkboxes["mail.read.v1"].checked = true;
  fixture.checkboxes["mail.send-confirmed.v1"].checked = true;
  await fixture.submitCapabilitiesForm();

  assert.equal(fixture.calls.permissionsRequest.length, 1);
  assert.deepEqual(fixture.calls.setMailCapabilities[0], ["mail.read.v1"], "被拒绝的外发能力不应该出现在写入 setMailCapabilities 的集合里");
  assert.equal(fixture.checkboxes["mail.send-confirmed.v1"].checked, false, "被拒绝后复选框必须回退为未勾选，不能停留在“看起来选中”的状态");
  assert.match(fixture.elements["#capabilities-status"].textContent, /浏览器拒绝了 compose\.send 权限请求/);
});

test("Task #44：取消勾选外发确认能力并提交时，调用 permissions.remove 收回 compose.send，不调用 request", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: ["mail.send-confirmed.v1"] }));
  await loadOptions(fixture);

  fixture.checkboxes["mail.send-confirmed.v1"].checked = false;
  await fixture.submitCapabilitiesForm();

  assert.equal(fixture.calls.permissionsRequest.length, 0);
  assert.equal(fixture.calls.permissionsRemove.length, 1);
  assert.deepEqual(fixture.calls.permissionsRemove[0], { permissions: ["compose.send"] });
  assert.deepEqual(fixture.calls.setMailCapabilities[0], []);
});

test("Task #45：勾选外发能力、浏览器同意弹窗、但 setMailCapabilities 保存失败时，必须回滚刚拿到的 compose.send 权限，不留悬空授权", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: [] }));
  await loadOptions(fixture);
  fixture.setPermissionGrantedBaseline(false);
  fixture.setPermissionRequestResult(true);
  fixture.browser.thunderbirdSkillBridge.setMailCapabilities = async () => { throw new Error("模拟保存失败"); };

  fixture.checkboxes["mail.send-confirmed.v1"].checked = true;
  await fixture.submitCapabilitiesForm();

  assert.equal(fixture.calls.permissionsRequest.length, 1, "应该真的请求过一次权限");
  assert.equal(fixture.calls.permissionsRemove.length, 1, "保存失败后必须回滚这次新拿到的权限");
  assert.deepEqual(fixture.calls.permissionsRemove[0], { permissions: ["compose.send"] });
  assert.equal(fixture.isPermissionGranted(), false, "回滚后浏览器层不应该再持有 compose.send");
  assert.match(fixture.elements["#capabilities-status"].textContent, /保存失败：模拟保存失败/);
});

test("Task #45：提交前已经持有 compose.send 权限，本次 setMailCapabilities 保存失败时，不应该撤销这份已有权限（不放大不相关失败的影响）", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: ["mail.send-confirmed.v1"] }));
  await loadOptions(fixture);
  fixture.setPermissionGrantedBaseline(true);
  fixture.browser.thunderbirdSkillBridge.setMailCapabilities = async () => { throw new Error("模拟保存失败"); };

  fixture.checkboxes["mail.send-confirmed.v1"].checked = true;
  await fixture.submitCapabilitiesForm();

  assert.equal(fixture.calls.permissionsRequest.length, 1, "选中外发能力仍会调用一次 request()（真实行为：已持有时不弹窗、直接返回 true）");
  assert.equal(fixture.calls.permissionsRemove.length, 0, "不应该因为这次保存失败就撤销提交前已经持有的权限");
  assert.equal(fixture.isPermissionGranted(), true, "已有权限必须原样保留");
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

test("撤销配对按钮仅在 paired 状态下可用；撤销时一并收回 compose.send 可选权限，不留悬空授权", async () => {
  const fixture = createFixture();
  fixture.setGetState(async () => fixture.baseState({ pairingState: "paired", clientId: "client_demo", capabilities: ["mail.send-confirmed.v1"] }));
  await loadOptions(fixture);
  assert.equal(fixture.elements["#revoke-pairing"].disabled, false);
  await fixture.elements["#revoke-pairing"]._listeners.click({});
  assert.equal(fixture.calls.revokePairing.length, 1);
  assert.equal(fixture.calls.permissionsRemove.length, 1);
  assert.deepEqual(fixture.calls.permissionsRemove[0], { permissions: ["compose.send"] });
});
