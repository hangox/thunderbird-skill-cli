// 执行级邮件 route 通用分发管线测试（Task #33 收尾）。
// 全部真实执行 extension/bridge/api.js 内部的 preflight/dispatch 与
// Experiment→background operation 通道（onOperation/respondToOperation/
// failOperation），不做任何源码字符串断言。
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequest, grantMailCapabilities, handle, makeIdentity, startExperiment } from "./helpers/experiment-harness.mjs";

const PAIRING_PATH = "/v1/pairing/intents";
const ACCOUNTS_LIST_PATH = "/v1/mail/accounts.list";

function pairingBody(identity) {
  return JSON.stringify({ clientId: identity.clientId, publicKeyAlgorithm: "Ed25519", publicKeySpkiBase64: identity.publicKeySpkiBase64 });
}

async function withHarness(t, callback) {
  const harness = await startExperiment();
  t.after(() => harness.cleanup());
  return callback(harness);
}

// 夹具里的 hiddenWindow.setTimeout 会 unref() 定时器句柄（避免遗忘的定时器
// 拖住测试进程退出），但这意味着"只靠内部这个 unref 定时器触发"的 await 在
// 事件循环没有其它 ref'd 工作时可能被判定为"循环已空"而永远等不到——这不是
// 生产环境的行为（生产里 Thunderbird 进程本身一直存活），只是这个纯 Node 测试
// 进程的假象。用一个真实、默认 ref'd 的 setTimeout 在同等时长内占住事件循环，
// 内部的 unref 定时器仍会在真实挂钟时间到达时正常触发。
function keepEventLoopAlive(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 走完整配对：POST intent → UI confirm。返回已配对身份。 */
async function pair(harness, identity) {
  const request = buildRequest(harness, { method: "POST", path: PAIRING_PATH, bodyText: pairingBody(identity), identity });
  const created = await handle(harness, request);
  assert.equal(created.status, 201, `配对 intent 创建失败: ${created.message}`);
  await harness.api.confirmPairing(created.body.intentId, created.body.challengeCode);
  return created.body;
}

/** 注册一个一次性 onOperation 监听器，收到事件后按 respond 调用响应，并返回收到的事件参数供断言。 */
function listenOnce(harness, respond) {
  let captured;
  const listener = async (token, routeId, capability, bodyJson) => {
    captured = { token, routeId, capability, body: JSON.parse(bodyJson) };
    await respond(token, captured);
  };
  harness.api.onOperation.addListener(listener);
  return { listener, captured: () => captured };
}

test("未授权 capability 在到达 background 之前就 403 E_POLICY_DENIED，且不触发 onOperation", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    let fired = false;
    harness.api.onOperation.addListener(() => { fired = true; });

    const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
    assert.equal(result.status, 403);
    assert.equal(result.code, "E_POLICY_DENIED");
    assert.equal(fired, false, "capability 门禁应在 dispatch 转发之前就拒绝，不该触发 onOperation");
  });
});

test("请求 body 超过该 route 的 maxRequestBodyBytes 时 413，不触发 onOperation", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);
    let fired = false;
    harness.api.onOperation.addListener(() => { fired = true; });

    // accounts.list 的 maxRequestBodyBytes 是 1024；构造一个明显超限的 body。
    const bodyText = JSON.stringify({ padding: "x".repeat(2000) });
    const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText, identity }));
    assert.equal(result.status, 413);
    assert.equal(fired, false);
  });
});

test("body 含 __proto__/constructor（含嵌套）一律 400 E_VALIDATION，不触发 onOperation", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);

    const cases = [
      '{"__proto__":{"polluted":true}}',
      '{"constructor":{"polluted":true}}',
      '{"nested":{"prototype":{"polluted":true}}}',
      '{"list":[{"__proto__":{"polluted":true}}]}',
    ];
    for (const bodyText of cases) {
      let fired = false;
      const listener = () => { fired = true; };
      harness.api.onOperation.addListener(listener);
      const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText, identity }));
      harness.api.onOperation.removeListener(listener);
      assert.equal(result.status, 400, bodyText);
      assert.equal(result.code, "E_VALIDATION", bodyText);
      assert.equal(fired, false, bodyText);
    }
  });
});

test("无监听者时立即 503 E_THUNDERBIRD_OFFLINE，不等到 deadline", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);

    const startedAt = Date.now();
    const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity, deadlineMs: 5_000 }));
    assert.equal(result.status, 503);
    assert.equal(result.code, "E_THUNDERBIRD_OFFLINE");
    assert.ok(Date.now() - startedAt < 500, "无监听者应快速失败，不应接近 5s 的 deadline");
  });
});

test("监听者注册但从不响应：在 deadlineAt 到期后精确 408 E_TIMEOUT", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);
    harness.api.onOperation.addListener(() => { /* 故意不调用 respondToOperation/failOperation */ });

    const startedAt = Date.now();
    const resultPromise = handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity, deadlineMs: 80 }));
    await keepEventLoopAlive(300);
    const result = await resultPromise;
    assert.equal(result.status, 408);
    assert.equal(result.code, "E_TIMEOUT");
    assert.ok(Date.now() - startedAt >= 80, "必须真的等到 deadline 才超时");
  });
});

test("respondToOperation 成功路径：200 且响应体等于 background 提交的结果", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);

    const payload = { accounts: [{ id: "acc_demo", name: "Demo" }] };
    const { captured } = listenOnce(harness, async (token) => {
      await harness.api.respondToOperation(token, JSON.stringify(payload));
    });

    const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, payload);
    assert.equal(captured().routeId, "accounts.list");
    assert.equal(captured().capability, "mail.read.v1");
  });
});

for (const [errorCode, expectedStatus] of [
  ["E_NOT_IMPLEMENTED", 501],
  ["E_NOT_FOUND", 404],
  ["E_POLICY_DENIED", 403],
  ["E_CONFIRMATION_REQUIRED", 409],
  ["E_VALIDATION", 400],
  ["E_TIMEOUT", 408],
  ["E_THUNDERBIRD_OFFLINE", 503],
  ["E_INTERNAL", 500],
  ["E_TOTALLY_UNKNOWN_CODE", 500],
]) {
  test(`failOperation(${errorCode}) 映射为 HTTP ${expectedStatus}`, async (t) => {
    await withHarness(t, async (harness) => {
      const identity = makeIdentity();
      await pair(harness, identity);
      await grantMailCapabilities(harness, ["mail.read.v1"]);
      harness.api.onOperation.addListener(async (token) => {
        await harness.api.failOperation(token, errorCode, "测试用错误信息");
      });

      const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
      assert.equal(result.status, expectedStatus, errorCode);
      // 未知错误码必须降级为 E_INTERNAL，不能把业务侧的任意字符串直接冒充协议错误码。
      assert.equal(result.code, errorCode === "E_TOTALLY_UNKNOWN_CODE" ? "E_INTERNAL" : errorCode, errorCode);
    });
  });
}

// ---------------------------------------------------------------------------
// 结构化失败 details 透传（Task #43）：background 通过 failOperation 的第
// 四个参数 detailsJson 附带结构化详情（目前唯一用例是 drafts.send.confirm
// 失败时的 operationId，替代此前"拼进 errorMessage 文本、调用方 regex 解析"
// 的隐式协议）。这里直接驱动真实 api.js 的 failOperation/sanitizeMailErrorDetails，
// 不经过任何 background 业务 handler——background 侧已经在
// test/mail-write-integration.test.mjs 的 send-failed 用例里覆盖过一次
// "真的会正确序列化 details"，这里覆盖的是 api.js 这一侧独立的 allowlist
// 校验本身，两层互不信任对方已经做对。
// ---------------------------------------------------------------------------

test("failOperation 携带合法 detailsJson（{operationId}）时，HTTP error envelope 的 error.details 原样透传", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);
    const operationId = `op_${"a".repeat(16)}`;
    harness.api.onOperation.addListener(async (token) => {
      await harness.api.failOperation(token, "E_INTERNAL", "外发失败：请通过 operations get 查询最新状态", JSON.stringify({ operationId }));
    });

    const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
    assert.equal(result.status, 500);
    // result.details 是在 vm 沙箱 realm 里创建的对象，跨 realm 的 deepEqual
    // 会因为原型不是同一个 Object.prototype 报 "same structure but not
    // reference-equal"——JSON 往返把它变回当前 realm 的纯对象再比较。
    assert.deepEqual(JSON.parse(JSON.stringify(result.details)), { operationId });
  });
});

test("failOperation 的 detailsJson 携带 allowlist 之外的字段（token/nonce/path/subject/body）时，全部字段一律被丢弃，只保留合法的 operationId", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);
    const operationId = `op_${"b".repeat(16)}`;
    const malicious = {
      operationId,
      token: "tok_should_never_leak",
      nonce: "canary-nonce-value",
      path: "/Users/victim/.ssh/id_ed25519",
      subject: "机密主题",
      body: "机密正文内容",
      address: "victim@example.com",
    };
    harness.api.onOperation.addListener(async (token) => {
      await harness.api.failOperation(token, "E_INTERNAL", "外发失败", JSON.stringify(malicious));
    });

    const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
    assert.deepEqual(JSON.parse(JSON.stringify(result.details)), { operationId }, "只应保留 operationId，其余全部字段都必须被丢弃");
    const raw = JSON.stringify(result.details);
    for (const canary of ["tok_should_never_leak", "canary-nonce-value", "id_ed25519", "机密主题", "机密正文内容", "victim@example.com"]) {
      assert.doesNotMatch(raw, new RegExp(canary.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")), `details 不应包含 canary：${canary}`);
    }
  });
});

test("failOperation 的 detailsJson 格式不合法（非 JSON/是数组/operationId 格式不符/缺省）时，error.details 整体缺失，不影响 code/message 正常返回", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);

    const cases = [
      "not valid json{{{",
      JSON.stringify(["array", "not", "object"]),
      JSON.stringify({ operationId: "not-a-valid-op-ref" }),
      JSON.stringify({ operationId: 12345 }),
      JSON.stringify(null),
      undefined,
    ];
    for (const detailsJson of cases) {
      const listener = async (token) => { await harness.api.failOperation(token, "E_INTERNAL", "外发失败", detailsJson); };
      harness.api.onOperation.addListener(listener);
      const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
      assert.equal(result.status, 500, `detailsJson=${detailsJson}`);
      assert.equal(result.code, "E_INTERNAL", `detailsJson=${detailsJson}`);
      assert.equal(result.details, undefined, `不合法 detailsJson 应整体丢弃 details：${detailsJson}`);
      harness.api.onOperation.removeListener(listener);
    }
  });
});

test("revokePairing 立即让撤销前发起、仍在等待的 operation 失败，不悬挂到 deadline 才超时", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);
    // 在 onOperation 监听器内部触发 revoke，保证此刻请求已经真正通过了
    // preflight 认证并在 dispatch() 里建立了 operationChannel 的挂起 Promise
    // （onOperation 正是 dispatch() 调用 fireEvent 之后才触发的）——这才是
    // "background 处理过程中发生 revoke"，而不是在更早的认证阶段就撞上
    // 已有的 epoch 变更检测（那条路径已经被 S6 系列用例覆盖，是另一件事）。
    harness.api.onOperation.addListener(async () => {
      await harness.api.revokePairing();
    });

    const startedAt = Date.now();
    // deadline 故意设很长：如果 revoke 没有主动清空挂起的 operation，
    // 这个断言会因为 5s 内拿不到结果而超出测试自身超时，能明确暴露悬挂问题。
    const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity, deadlineMs: 5_000 }));
    assert.equal(result.status, 503);
    assert.equal(result.code, "E_THUNDERBIRD_OFFLINE");
    assert.ok(Date.now() - startedAt < 500, "revoke 应立即唤醒挂起的 operation，不应等到 deadline");
  });
});

test("setMailCapabilities 未配对时拒绝，配对后只接受已知能力标识且覆盖式写入", async (t) => {
  await withHarness(t, async (harness) => {
    await assert.rejects(harness.api.setMailCapabilities(["mail.read.v1"]));

    const identity = makeIdentity();
    await pair(harness, identity);
    await assert.rejects(harness.api.setMailCapabilities(["not-a-real-capability"]));
    await assert.rejects(harness.api.setMailCapabilities("mail.read.v1"));

    const first = await harness.api.setMailCapabilities(["mail.read.v1", "draft.write.v1"]);
    assert.equal(first.pairingState, "paired");
    const status = await handle(harness, buildRequest(harness, { identity }));
    assert.equal(status.status, 200);

    // 覆盖式写入：第二次调用应替换而不是追加。
    await harness.api.setMailCapabilities(["mail.reversible.v1"]);
    const granted = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
    // mail.read.v1 已被覆盖掉，accounts.list 需要 mail.read.v1，应重新变回 403。
    assert.equal(granted.status, 403);
    assert.equal(granted.code, "E_POLICY_DENIED");
  });
});

// ---------------------------------------------------------------------------
// operationChannel 生命周期（Task #47）：真实 Gecko 会在 MV3 classic
// background 脚本被销毁重建时，用一个新的 `context` 重新调用
// `getAPI(context)`。修复前，`globalThis.__tbSkillState ??= {...
// operationChannel: createOperationChannel(context) ...}` 里的 `??=` 短路
// 意味着 operationChannel/pairingRevokedEvent 只会绑定到第一次见到的
// context；旧 context 死亡时真实 EventManager 会自动 unregister（把
// `fireEvent` 置空），但缓存的 operationChannel 对象从不会被替换——于是
// background 重建之后，新脚本重新注册的 onOperation 监听器永远收不到
// dispatch() fireEvent 出来的事件，所有邮件 route 请求都会立即变成 503
// E_THUNDERBIRD_OFFLINE，即使 HTTP server/pairing/能力状态本身完全正常。
// 这里用 harness.reconnectBackgroundContext()（内部驱动真实 FakeEventManager
// 的 context.close() 自动 unregister）复现这个场景并验证修复。
// ---------------------------------------------------------------------------

test("MV3 background context 重建后，新注册的 onOperation 监听器能正常收到事件，不会永久 503 E_THUNDERBIRD_OFFLINE（Task #47 回归）", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);

    // 重建前：验证 onOperation/respondToOperation 走的是正常路径。
    const payloadBefore = { accounts: [{ id: "acc_before", name: "Before" }] };
    listenOnce(harness, async (token) => {
      await harness.api.respondToOperation(token, JSON.stringify(payloadBefore));
    });
    const resultBefore = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
    assert.equal(resultBefore.status, 200);
    assert.deepEqual(resultBefore.body, payloadBefore);

    const descriptorBefore = harness.descriptor();

    // 模拟 MV3 classic background 脚本被销毁重建：旧 context 触发
    // FakeEventManager 的自动 unregister，getAPI() 用新 context 重新调用。
    const newApi = harness.reconnectBackgroundContext();
    assert.notEqual(newApi, undefined);

    // server/pairing/epoch 状态不应该在 context 重建过程中被错误重置。
    const descriptorAfter = harness.descriptor();
    assert.equal(descriptorAfter.pairingEpoch, descriptorBefore.pairingEpoch, "重建不应改变 pairing epoch");
    assert.equal(descriptorAfter.sessionToken, descriptorBefore.sessionToken, "重建不应轮换 sessionToken");

    // 重建后必须仍能走已授权的能力路径（setMailCapabilities 的写入应存续）。
    const payloadAfter = { accounts: [{ id: "acc_after", name: "After" }] };
    const after = listenOnce(harness, async (token) => {
      await harness.api.respondToOperation(token, JSON.stringify(payloadAfter));
    });
    const startedAt = Date.now();
    const resultAfter = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
    // 修复前：dispatch() 内部 fireEvent 调用的仍是绑定在旧（已死亡）context
    // 上的 operationChannel，新监听器完全收不到事件，这里会立即（远早于
    // 5s 默认 deadline）拿到 503 E_THUNDERBIRD_OFFLINE。
    assert.equal(resultAfter.status, 200, `修复前会在这里得到 503 E_THUNDERBIRD_OFFLINE；实际 status=${resultAfter.status} code=${resultAfter.code}`);
    assert.deepEqual(resultAfter.body, payloadAfter);
    assert.equal(after.captured().routeId, "accounts.list");
    assert.ok(Date.now() - startedAt < 500, "重建后的请求应正常快速完成，不应挂到 deadline");
  });
});

test("MV3 background context 重建后，旧 context 上的 onOperation 监听器随之失效，不会残留双触发", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    await grantMailCapabilities(harness, ["mail.read.v1"]);

    const oldApi = harness.api;
    let oldListenerFired = false;
    oldApi.onOperation.addListener(() => { oldListenerFired = true; });

    harness.reconnectBackgroundContext();

    const payload = { accounts: [] };
    listenOnce(harness, async (token) => {
      await harness.api.respondToOperation(token, JSON.stringify(payload));
    });
    const result = await handle(harness, buildRequest(harness, { method: "POST", path: ACCOUNTS_LIST_PATH, bodyText: "{}", identity }));
    assert.equal(result.status, 200);
    assert.equal(oldListenerFired, false, "旧 context 的监听器应随 context 销毁一并失效，不应再被新事件触发");
  });
});

test("listMailRoutes() 与 src/contracts/routes.ts 的 MAIL_ROUTES id 集合完全一致", async (t) => {
  await withHarness(t, async (harness) => {
    const { MAIL_ROUTES } = await import("../dist/contracts/routes.js");
    const expected = new Set(MAIL_ROUTES.map((route) => route.id));
    const actual = new Set(await harness.api.listMailRoutes());
    assert.deepEqual([...actual].sort(), [...expected].sort());
  });
});
