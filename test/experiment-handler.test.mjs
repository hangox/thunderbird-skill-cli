// 执行级 Experiment handler 测试（S2/S5/S6/S7）。
// 这些用例全部真实执行 extension/bridge/api.js 内部的 preflight/dispatch，
// 不做任何源码字符串断言。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { buildRequest, handle, makeIdentity, makeResponse, startExperiment, toWireText } from "./helpers/experiment-harness.mjs";

const PAIRING_PATH = "/v1/pairing/intents";

function pairingBody(identity, overrides = {}) {
  const body = { clientId: identity.clientId, publicKeyAlgorithm: "Ed25519", publicKeySpkiBase64: identity.publicKeySpkiBase64, ...overrides };
  for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete body[key];
  return JSON.stringify(body);
}

async function withHarness(t, callback) {
  const harness = await startExperiment();
  t.after(() => harness.cleanup());
  return callback(harness);
}

/** 走完整配对：POST intent → UI confirm。返回已配对身份。 */
async function pair(harness, identity) {
  const bodyText = pairingBody(identity);
  const request = buildRequest(harness, { method: "POST", path: PAIRING_PATH, bodyText, identity });
  const created = await handle(harness, request);
  assert.equal(created.status, 201, `配对 intent 创建失败: ${created.message}`);
  await harness.api.confirmPairing(created.body.intentId, created.body.challengeCode);
  return created.body;
}

// ---------------------------------------------------------------- S2 执行证据

test("S2 已配对状态下缺签名、错签名、错 client 在 signed status 上一律被拒", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);

    const missing = await handle(harness, buildRequest(harness, {}));
    assert.equal(missing.status, 401);
    assert.equal(missing.message, "client 签名认证失败");

    const wrongSignature = await handle(harness, buildRequest(harness, { identity, signature: Buffer.alloc(64).toString("base64") }));
    assert.equal(wrongSignature.status, 401);
    assert.equal(wrongSignature.message, "client 签名认证失败");

    const other = makeIdentity("client_intruder01");
    const wrongClient = await handle(harness, buildRequest(harness, { identity: other }));
    assert.equal(wrongClient.status, 401);
    assert.equal(wrongClient.message, "client 签名认证失败");

    // 正确签名仍必须通过，证明上面三条不是因为链路整体坏掉。
    const good = await handle(harness, buildRequest(harness, { identity }));
    assert.equal(good.status, 200);
    assert.equal(good.body.pairingState, "paired");
  });
});

test("S2 已配对状态下 POST 与未知 route 在路由/业务处理前就被认证拒绝", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    const other = makeIdentity("client_intruder02");

    // POST 到已配对状态的 pairing route：签名无效必须先于 E_ALREADY_PAIRED 业务判定被拒。
    const badPost = await handle(harness, buildRequest(harness, {
      method: "POST", path: PAIRING_PATH, bodyText: pairingBody(other), identity: other,
    }));
    assert.equal(badPost.status, 401);
    assert.equal(badPost.message, "client 签名认证失败");

    // 未知 route：同样必须先认证失败，而不是回 404 route 不存在。
    const unknown = await handle(harness, buildRequest(harness, { path: "/v1/unknown", identity: other }));
    assert.equal(unknown.status, 401);
    assert.equal(unknown.message, "client 签名认证失败");

    // 未知 route 即使签名正确，也只能拿到 route 拒绝，绝不进入任何业务分支。
    const unknownSigned = await handle(harness, buildRequest(harness, { path: "/v1/unknown", identity }));
    assert.equal(unknownSigned.status, 400);
    assert.equal(unknownSigned.message, "route 不允许");
  });
});

test("S2 无效 session token 在签名、route、Content-Type 校验之前统一失败关闭", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    const result = await handle(harness, buildRequest(harness, {
      method: "POST", path: "/v1/unknown", contentType: "text/plain",
      sessionToken: "0".repeat(64), identity,
    }));
    assert.equal(result.status, 401);
    assert.equal(result.message, "认证失败");
  });
});

// ---------------------------------------------------------------- S5 pending 替换

test("S5 同一 clientId 用新公钥可替换在途 pending 并换发新 intentId 与挑战码", async (t) => {
  await withHarness(t, async (harness) => {
    const first = makeIdentity("client_rotating01");
    const created = await handle(harness, buildRequest(harness, {
      method: "POST", path: PAIRING_PATH, bodyText: pairingBody(first), identity: first,
    }));
    assert.equal(created.status, 201);

    // 同一 clientId、全新密钥对：候选自签名有效，因此允许替换。
    const rotated = { ...makeIdentity("client_rotating01") };
    const replaced = await handle(harness, buildRequest(harness, {
      method: "POST", path: PAIRING_PATH, bodyText: pairingBody(rotated), identity: rotated,
    }));
    assert.equal(replaced.status, 201);
    assert.notEqual(replaced.body.intentId, created.body.intentId);
    assert.notEqual(replaced.body.challengeCode, created.body.challengeCode);
    assert.equal(replaced.body.clientId, "client_rotating01");

    // 替换后确认必须绑定到新的 intent；旧 intentId 已失效。
    await assert.rejects(harness.api.confirmPairing(created.body.intentId, created.body.challengeCode));
    const state = await harness.api.confirmPairing(replaced.body.intentId, replaced.body.challengeCode);
    assert.equal(state.pairingState, "paired");
  });
});

test("S5 不同 clientId 在途 pending 冲突返回 409 E_PAIRING_PENDING 且不覆盖原 intent", async (t) => {
  await withHarness(t, async (harness) => {
    const first = makeIdentity("client_holder0001");
    const created = await handle(harness, buildRequest(harness, {
      method: "POST", path: PAIRING_PATH, bodyText: pairingBody(first), identity: first,
    }));
    assert.equal(created.status, 201);

    const intruder = makeIdentity("client_intruder03");
    const rejected = await handle(harness, buildRequest(harness, {
      method: "POST", path: PAIRING_PATH, bodyText: pairingBody(intruder), identity: intruder,
    }));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.code, "E_PAIRING_PENDING");

    // 原 pending 未被破坏：仍可用原挑战码确认，且确认后的 client 是原持有者。
    const state = await harness.api.confirmPairing(created.body.intentId, created.body.challengeCode);
    assert.equal(state.pairingState, "paired");
    assert.equal(state.clientId, "client_holder0001");
  });
});

test("S5 替换路径不削弱重放保护：同一 nonce 第二次仍是 E_REPLAY", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity("client_replay0001");
    const bodyText = pairingBody(identity);
    const request = buildRequest(harness, { method: "POST", path: PAIRING_PATH, bodyText, identity });
    const first = await handle(harness, request);
    assert.equal(first.status, 201);
    const replay = buildRequest(harness, {
      method: "POST", path: PAIRING_PATH, bodyText, identity,
      requestId: request.headers.get("x-request-id"),
      timestamp: request.headers.get("x-request-timestamp"),
      nonce: request.headers.get("x-request-nonce"),
    });
    const second = await handle(harness, replay);
    assert.equal(second.status, 409);
    assert.equal(second.code, "E_REPLAY");
  });
});

// ---------------------------------------------------------------- S6 signed pairing epoch

test("S6 descriptor 与 status 全链带 pairingEpoch，descriptorVersion=2 且 protocolVersion=1", async (t) => {
  await withHarness(t, async (harness) => {
    const descriptor = harness.descriptor();
    assert.equal(descriptor.descriptorVersion, 2);
    assert.equal(descriptor.protocolVersion, 1);
    assert.equal(descriptor.pairingEpoch, "0");

    const identity = makeIdentity();
    await pair(harness, identity);
    const status = await handle(harness, buildRequest(harness, { identity }));
    assert.equal(status.status, 200);
    assert.equal(status.body.protocolVersion, 1);
    assert.equal(status.body.pairingEpoch, "0");
  });
});

test("S6 revoke 单调递增并持久化 epoch，重启后保持且不被清对重置", async (t) => {
  const harness = await startExperiment();
  t.after(() => harness.cleanup());
  const identity = makeIdentity();
  await pair(harness, identity);
  assert.equal(harness.descriptor().pairingEpoch, "0");

  const afterRevoke = await harness.api.revokePairing();
  assert.equal(afterRevoke.pairingEpoch, "1");
  assert.equal(afterRevoke.pairingState, "revoked");
  assert.equal(harness.descriptor().pairingEpoch, "1");
  // epoch 存在独立 pref 中，clearPairing 删掉的是另一把 key。
  assert.equal(harness.prefs.get("extensions.thunderbird-skill-bridge.pairingEpoch"), "1");
  assert.equal(harness.prefs.has("extensions.thunderbird-skill-bridge.pairing"), false);

  // 模拟重启：复用同一份 prefs 起一个全新实例。
  harness.onShutdown();
  const restarted = await startExperiment({ prefs: harness.prefs });
  t.after(() => restarted.cleanup());
  assert.equal(restarted.descriptor().pairingEpoch, "1");
  const secondIdentity = makeIdentity("client_afterboot1");
  await pair(restarted, secondIdentity);
  assert.equal((await restarted.api.revokePairing()).pairingEpoch, "2");
});

test("S6 revoke 后旧签名立即失效，重新配对同 client 同密钥后旧预签请求精确 409", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity("client_stableKey1");
    await pair(harness, identity);
    const staleEpoch = harness.descriptor().pairingEpoch;
    assert.equal(staleEpoch, "0");
    assert.equal((await handle(harness, buildRequest(harness, { identity }))).status, 200);

    await harness.api.revokePairing();
    // 完全相同的 client、完全相同的密钥重新配对：pairing 记录与公钥都回到了可用状态。
    await pair(harness, identity);
    assert.equal(harness.descriptor().pairingEpoch, "1");

    // revoke 会同时轮换 session token，这本身就是一层独立防御。为了证明 epoch 机制单独也成立，
    // 这里刻意用轮换后的新 token，只让 pairingEpoch 停留在撤销前的旧值。
    const stale = await handle(harness, buildRequest(harness, { identity, pairingEpoch: staleEpoch, signedEpoch: staleEpoch }));
    assert.equal(stale.status, 409);
    assert.equal(stale.code, "E_PAIRING_CHANGED");

    // 附带确认 token 轮换这层防御同样生效：旧 token + 新 epoch 也过不去。
    const staleToken = await handle(harness, buildRequest(harness, { identity, sessionToken: "0".repeat(64) }));
    assert.equal(staleToken.status, 401);
    assert.equal(staleToken.message, "认证失败");
  });
});

test("S6 verify 之后、dispatch 之前发生 revoke：精确 409、无副作用、无成功、无 500", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity("client_racewindow");
    const bodyText = pairingBody(identity);
    const request = buildRequest(harness, { method: "POST", path: PAIRING_PATH, bodyText, identity });

    await harness.preflight(request);
    // preflight 已完成验签，此刻 revoke 推进 epoch。
    await harness.api.revokePairing();

    const response = makeResponse();
    let thrown;
    try { await harness.dispatch(request, response); } catch (error) { thrown = error; }
    assert.ok(thrown, "dispatch 必须抛出而不是静默成功");
    assert.equal(thrown.status, 409);
    assert.equal(thrown.code, "E_PAIRING_CHANGED");
    assert.notEqual(thrown.status, 500);
    // 无副作用：没有写出任何响应体，也没有产生新的 pending。
    assert.equal(response.captured.finished, false);
    assert.equal(response.captured.body, "");
    assert.equal((await harness.api.getState()).pendingIntentId, null);
  });
});

test("S6 CLI 侧 descriptor/status 的 pairingEpoch 不一致会被拒绝", async () => {
  const { fetchStatus } = await import("../dist/transport.js");
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      protocolVersion: 1, minCliVersion: "0.3.0", maxCliVersion: "0.3.0", extensionVersion: "0.3.0",
      instanceId: "inst_epochmismatch", profileId: `sha256:${"4".repeat(64)}`,
      capabilities: [], pairingState: "paired", pairingEpoch: "9", authorizedAccountRefs: [],
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const descriptor = {
    descriptorVersion: 2, protocolVersion: 1, instanceId: "inst_epochmismatch", profileId: `sha256:${"4".repeat(64)}`,
    profileLabel: "Epoch Fixture", pid: process.pid, port, sessionToken: "5".repeat(64), extensionVersion: "0.3.0",
    pairingEpoch: "3", startedAt: "2026-07-25T00:00:00.000Z", expiresAt: "2099-07-25T01:00:00.000Z",
  };
  await assert.rejects(fetchStatus(descriptor, 1000), (error) => error.code === "E_PAIRING_CHANGED" && error.retryable === true);
  await new Promise((resolve) => server.close(resolve));
});

test("S6 epoch header 缺失、篡改与所有宽松数值写法全部 fail-closed", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    const descriptor = harness.descriptor();

    // 格式非法：一律在认证元数据关卡 401 拒绝，绝不进入 Number/parseInt 宽松解析。
    const malformed = ["007", "+7", "0x10", "1e3", "1.5", " 7", "7 ", "-1", "", "00", "1_0", "٧", "1".repeat(17)];
    for (const value of malformed) {
      const result = await handle(harness, buildRequest(harness, { identity, pairingEpoch: value, signedEpoch: value }));
      assert.equal(result.status, 401, `epoch=${JSON.stringify(value)} 应 401`);
      assert.equal(result.message, "请求认证元数据无效", `epoch=${JSON.stringify(value)}`);
    }

    // 完全缺失该 header。
    const missing = await handle(harness, buildRequest(harness, { identity, pairingEpoch: null, signedEpoch: "" }));
    assert.equal(missing.status, 401);
    assert.equal(missing.message, "请求认证元数据无效");

    // 格式合法但值不匹配：409 E_PAIRING_CHANGED。
    for (const value of ["1", "2", "9007199254740993"]) {
      const result = await handle(harness, buildRequest(harness, { identity, pairingEpoch: value, signedEpoch: value }));
      assert.equal(result.status, 409, `epoch=${value} 应 409`);
      assert.equal(result.code, "E_PAIRING_CHANGED");
    }

    // 篡改 header 但沿用旧 epoch 的签名：即使值恰好合法也过不了。
    const tampered = await handle(harness, buildRequest(harness, { identity, pairingEpoch: "1", signedEpoch: descriptor.pairingEpoch }));
    assert.equal(tampered.status, 409);
    assert.equal(tampered.code, "E_PAIRING_CHANGED");
  });
});

test("S6 epoch 进入 canonical：签名覆盖 epoch，签名体与 header 不一致即失败", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    // header 是当前正确的 "0"，但签名是按 "0" 之外的值算的 → 验签失败。
    const mismatched = await handle(harness, buildRequest(harness, { identity, pairingEpoch: "0", signedEpoch: "1" }));
    assert.equal(mismatched.status, 401);
    assert.equal(mismatched.message, "client 签名认证失败");
  });
});

test("S6 持久 epoch 值被破坏时启动失败关闭，绝不回落成 0", async (t) => {
  const prefs = new Map([["extensions.thunderbird-skill-bridge.pairingEpoch", "not-a-number"]]);
  await assert.rejects(startExperiment({ prefs }));
  const negative = new Map([["extensions.thunderbird-skill-bridge.pairingEpoch", "-3"]]);
  await assert.rejects(startExperiment({ prefs: negative }));
});

test("S6 canonical 变更通过版本握手提前给出 E_VERSION_MISMATCH，而不是 bump protocolVersion", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    // 旧 CLI：protocolVersion 仍是 1，但版本不匹配，必须在验签之前拿到 426。
    const outdated = await handle(harness, buildRequest(harness, { identity, clientVersion: "0.1.0" }));
    assert.equal(outdated.status, 426);
    assert.equal(outdated.code, "E_VERSION_MISMATCH");
    assert.equal(harness.descriptor().protocolVersion, 1);
  });
});

// ---------------------------------------------------------------- S7 algorithm assertion

test("S7 pairing body 必须恰好三键且 publicKeyAlgorithm 大小写敏感", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    const cases = [
      ["缺 publicKeyAlgorithm", { publicKeyAlgorithm: undefined }],
      ["缺 clientId", { clientId: undefined }],
      ["缺 publicKeySpkiBase64", { publicKeySpkiBase64: undefined }],
      ["额外第四键", { extra: "x" }],
      ["小写 ed25519", { publicKeyAlgorithm: "ed25519" }],
      ["大写 ED25519", { publicKeyAlgorithm: "ED25519" }],
      ["ECDSA-P256", { publicKeyAlgorithm: "ECDSA-P256" }],
      ["p256", { publicKeyAlgorithm: "p256" }],
      ["非字符串", { publicKeyAlgorithm: 1 }],
    ];
    for (const [name, overrides] of cases) {
      const bodyText = pairingBody(identity, overrides);
      const result = await handle(harness, buildRequest(harness, { method: "POST", path: PAIRING_PATH, bodyText, identity }));
      assert.equal(result.status, 400, name);
      assert.equal(result.message, "配对身份格式不合法", name);
    }
    // 合法 Ed25519 必须成功。
    const ok = await handle(harness, buildRequest(harness, { method: "POST", path: PAIRING_PATH, bodyText: pairingBody(identity), identity }));
    assert.equal(ok.status, 201);
  });
});

test("S7 P-256 SPKI 与任何非 Ed25519 SPKI 形状都被拒绝", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    const p256 = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const x25519 = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const truncated = identity.publicKeySpkiBase64.slice(0, 56) + "A===";
    const flipped = Buffer.from(identity.publicKeySpkiBase64, "base64");
    flipped[5] = flipped[5] ^ 0xff; // 破坏 OID 前缀但保持 44 字节
    for (const [name, value] of [["P-256", p256], ["RSA", rsa], ["X25519", x25519], ["截断", truncated], ["前缀被改", flipped.toString("base64")]]) {
      const bodyText = pairingBody(identity, { publicKeySpkiBase64: value });
      const result = await handle(harness, buildRequest(harness, { method: "POST", path: PAIRING_PATH, bodyText, identity }));
      assert.equal(result.status, 400, name);
    }
    // 合法 Ed25519 SPKI：恰 60 base64 字符 / 44 DER 字节 / 指定前缀。
    assert.equal(identity.publicKeySpkiBase64.length, 60);
    const der = Buffer.from(identity.publicKeySpkiBase64, "base64");
    assert.equal(der.length, 44);
    assert.equal(der.subarray(0, 12).toString("hex"), "302a300506032b6570032100");
  });
});

test("S7 Experiment beginPairing 入口与 HTTP 入口断言完全一致", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await assert.rejects(harness.api.beginPairing(identity.clientId, "ed25519", identity.publicKeySpkiBase64));
    await assert.rejects(harness.api.beginPairing(identity.clientId, "p256", identity.publicKeySpkiBase64));
    await assert.rejects(harness.api.beginPairing(identity.clientId, "Ed25519", "AAAA"));
    await assert.rejects(harness.api.beginPairing("bad", "Ed25519", identity.publicKeySpkiBase64));
    const state = await harness.api.beginPairing(identity.clientId, "Ed25519", identity.publicKeySpkiBase64);
    assert.equal(state.pairingState, "pairing");
    assert.equal(state.pendingClientId, identity.clientId);
  });
});

test("S7 pairing 持久记录保存 publicKeyAlgorithm，缺失或不匹配时加载失败关闭", async (t) => {
  const harness = await startExperiment();
  t.after(() => harness.cleanup());
  const identity = makeIdentity();
  await pair(harness, identity);
  const stored = JSON.parse(harness.prefs.get("extensions.thunderbird-skill-bridge.pairing"));
  assert.equal(stored.publicKeyAlgorithm, "Ed25519");
  harness.onShutdown();

  for (const [name, mutate] of [
    ["缺字段", (value) => { delete value.publicKeyAlgorithm; }],
    ["小写", (value) => { value.publicKeyAlgorithm = "ed25519"; }],
    ["P-256", (value) => { value.publicKeyAlgorithm = "p256"; }],
  ]) {
    const mutated = { ...stored };
    mutate(mutated);
    const prefs = new Map([["extensions.thunderbird-skill-bridge.pairing", JSON.stringify(mutated)]]);
    const restarted = await startExperiment({ prefs });
    t.after(() => restarted.cleanup());
    // 失败关闭：记录不被采信，实例回到 unpaired，而不是默认回填成 Ed25519。
    assert.equal((await restarted.api.getState()).pairingState, "unpaired", name);
    assert.equal((await restarted.api.getState()).clientId, null, name);
    restarted.onShutdown();
  }
});

test("S7 CLI 发送的 pairing body 恰好是三键常量", async () => {
  const { beginPairing } = await import("../dist/transport.js");
  const { createServer } = await import("node:http");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity = {
    clientId: "client_bodyshape01",
    publicKeyAlgorithm: "Ed25519",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  let seen;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen = { body: JSON.parse(Buffer.concat(chunks).toString("utf8")), headers: request.headers };
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ intentId: `intent_${"c".repeat(32)}`, challengeCode: "112233", clientId: identity.clientId, expiresAt: "2099-07-25T01:00:00.000Z", pairingState: "pairing" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await beginPairing({
    descriptorVersion: 2, protocolVersion: 1, instanceId: "inst_bodyshape01", profileId: `sha256:${"6".repeat(64)}`,
    profileLabel: "Body Fixture", pid: process.pid, port, sessionToken: "7".repeat(64), extensionVersion: "0.3.0",
    pairingEpoch: "4", startedAt: "2026-07-25T00:00:00.000Z", expiresAt: "2099-07-25T01:00:00.000Z",
  }, 1000, identity);
  assert.deepEqual(Object.keys(seen.body).sort(), ["clientId", "publicKeyAlgorithm", "publicKeySpkiBase64"]);
  assert.equal(seen.body.publicKeyAlgorithm, "Ed25519");
  assert.equal(seen.headers["x-thunderbird-pairing-epoch"], "4");
  assert.equal(seen.headers["x-thunderbird-client-version"], "0.3.0");
  assert.equal(seen.headers["x-thunderbird-signature-algorithm"], undefined);
  assert.equal(createHash("sha256").update(JSON.stringify(seen.body)).digest("hex"), seen.headers["x-content-sha256"]);
  await new Promise((resolve) => server.close(resolve));
});

test("S6 GET intent 在 preflight 与 dispatch 之间 revoke：409 且不因 pending 被清空而 500", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity("client_snapshot01");
    const created = await handle(harness, buildRequest(harness, {
      method: "POST", path: PAIRING_PATH, bodyText: pairingBody(identity), identity,
    }));
    assert.equal(created.status, 201);

    const request = buildRequest(harness, { path: `${PAIRING_PATH}/${created.body.intentId}`, identity });
    await harness.preflight(request);
    assert.ok(request.pairingCandidate, "preflight 必须留下 candidate 快照");

    // revoke 会把 state.pending 清空。dispatch 只能用快照，绝不能因重读 null 而抛 TypeError。
    await harness.api.revokePairing();
    assert.equal((await harness.api.getState()).pendingIntentId, null);

    const response = makeResponse();
    let thrown;
    try { await harness.dispatch(request, response); } catch (error) { thrown = error; }
    assert.ok(thrown);
    assert.equal(thrown.status, 409);
    assert.equal(thrown.code, "E_PAIRING_CHANGED");
    assert.equal(thrown.name, "Error");
    assert.doesNotMatch(String(thrown.message), /undefined|null|Cannot read/);
    assert.equal(response.captured.finished, false);
  });
});

test("S6 epoch 推进后 status 与 descriptor 始终一致，且 revoke 不回退", async (t) => {
  await withHarness(t, async (harness) => {
    for (let round = 0; round < 3; round += 1) {
      const identity = makeIdentity(`client_round${round}0001`);
      await pair(harness, identity);
      const descriptor = harness.descriptor();
      const status = await handle(harness, buildRequest(harness, { identity }));
      assert.equal(status.status, 200);
      assert.equal(status.body.pairingEpoch, descriptor.pairingEpoch, `round ${round}`);
      assert.equal(descriptor.pairingEpoch, String(round), `round ${round}`);
      await harness.api.revokePairing();
      assert.equal(harness.descriptor().pairingEpoch, String(round + 1));
    }
  });
});

// ------------------------------------------- 复核缺口修复：真实旧 CLI 与真实 HTTP parser

test("真实 0.1.0 旧 CLI（完全不发 pairingEpoch）必须精确 426 E_VERSION_MISMATCH 而非 401", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);

    // 旧 CLI 的真实形态：没有 X-Thunderbird-Pairing-Epoch 这个 header，
    // 签名也是按旧 canonical（不含 epoch）算的。
    const legacy = buildRequest(harness, { identity, clientVersion: "0.1.0", pairingEpoch: null, signedEpoch: "" });
    assert.equal(legacy.headers.has("x-thunderbird-pairing-epoch"), false, "夹具必须真的不带 epoch header");
    const result = await handle(harness, legacy);
    assert.equal(result.status, 426);
    assert.equal(result.code, "E_VERSION_MISMATCH");
    assert.notEqual(result.status, 401);

    // 走真实 HTTP parser 的同一场景，结论必须一致。
    const wire = toWireText(legacy, { omitEpoch: true });
    assert.doesNotMatch(wire, /X-Thunderbird-Pairing-Epoch/i);
    const parsed = await handle(harness, harness.parseRaw(wire));
    assert.equal(parsed.status, 426);
    assert.equal(parsed.code, "E_VERSION_MISMATCH");

    // 未配对实例上同样成立：版本判定不依赖任何业务状态。
    const fresh = await startExperiment();
    t.after(() => fresh.cleanup());
    const unpaired = await handle(fresh, buildRequest(fresh, { clientVersion: "0.1.0", pairingEpoch: null }));
    assert.equal(unpaired.status, 426);
    assert.equal(unpaired.code, "E_VERSION_MISMATCH");
  });
});

test("版本不兼容在验签与 nonce 消费之前短路，且不进入业务 dispatch", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    const nonce = "e".repeat(32);

    // 旧版本 + 同一 nonce：第一次 426。若 nonce 已被消费，第二次就会变成 E_REPLAY。
    const first = await handle(harness, buildRequest(harness, { identity, clientVersion: "0.1.0", nonce, pairingEpoch: null }));
    assert.equal(first.status, 426);
    const second = await handle(harness, buildRequest(harness, { identity, clientVersion: "0.1.0", nonce, pairingEpoch: null }));
    assert.equal(second.status, 426, "版本短路不得消费 nonce");

    // 同一 nonce 在兼容版本下仍然可用，进一步证明它此前未被消费。
    const ok = await handle(harness, buildRequest(harness, { identity, nonce }));
    assert.equal(ok.status, 200);

    // 未知 route + 旧版本：仍是 426，绝不进入 dispatch 的 route 分支。
    const unknown = await handle(harness, buildRequest(harness, { identity, path: "/v1/unknown", clientVersion: "0.1.0", pairingEpoch: null }));
    assert.equal(unknown.status, 426);
    assert.notEqual(unknown.message, "route 不允许");
  });
});

test("真实 HTTP parser：epoch header 两侧空白一律认证元数据非法，不得变成 E_PAIRING_CHANGED", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    assert.equal(harness.descriptor().pairingEpoch, "0");

    // 冒号之后的原始字节由 epochFieldValue 精确控制（含 OWS）。
    const cases = [
      ["值前多一个空格 ' 0'", "  0"],
      ["值后带空格 '0 '", " 0 "],
      ["值前后都有空格", "  0  "],
      ["制表符分隔", "\t0"],
      ["值后带制表符", " 0\t"],
      ["无 OWS 但值后有空格", "0 "],
    ];
    for (const [name, fieldValue] of cases) {
      // 每次都用全新请求：nonce 一次性，复用会被重放保护正确拦截而掩盖本用例意图。
      const result = await handle(harness, harness.parseRaw(toWireText(buildRequest(harness, { identity }), { epochFieldValue: fieldValue })));
      assert.equal(result.status, 401, name);
      assert.equal(result.message, "请求认证元数据无效", name);
      assert.notEqual(result.code, "E_PAIRING_CHANGED", `${name} 不得被 trim 后误判为 epoch 失配`);
    }

    // 唯一合法编码：一个标准 OWS 分隔符 + 干净值；无 OWS 也接受（HTTP 允许）。
    for (const fieldValue of [" 0", "0"]) {
      const ok = await handle(harness, harness.parseRaw(toWireText(buildRequest(harness, { identity }), { epochFieldValue: fieldValue })));
      assert.equal(ok.status, 200, `合法编码 ${JSON.stringify(fieldValue)} 应通过`);
    }
  });
});

test("真实 HTTP parser：其余 header 的通用 OWS 语义保持不变", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    // 每次都用全新请求，避免一次性 nonce 造成的误判。
    // 正常 OWS 编码可用。
    assert.equal((await handle(harness, harness.parseRaw(toWireText(buildRequest(harness, { identity }))))).status, 200);
    // 完全不带 OWS 也可用，证明 parser 未把 OWS 变成强制要求。
    assert.equal((await handle(harness, harness.parseRaw(toWireText(buildRequest(harness, { identity }), { noOws: true, epochFieldValue: "0" })))).status, 200);

    // 其他 header 仍按 HTTP 语义 trim：Host 值两侧空白不影响精确匹配。
    const raw = toWireText(buildRequest(harness, { identity })).replace(/\r\nHost: /, "\r\nHost:   ");
    assert.equal((await handle(harness, harness.parseRaw(raw))).status, 200, "Host 的通用 OWS 语义不应被改变");
  });
});

test("运行时 descriptor 与 status 自报的 extensionVersion 与发布版本一致", async (t) => {
  await withHarness(t, async (harness) => {
    const identity = makeIdentity();
    await pair(harness, identity);
    assert.equal(harness.descriptor().extensionVersion, "0.3.0");
    const status = await handle(harness, buildRequest(harness, { identity }));
    assert.equal(status.status, 200);
    assert.equal(status.body.extensionVersion, "0.3.0");
    assert.equal(status.body.minCliVersion, "0.3.0");
    assert.equal(status.body.maxCliVersion, "0.3.0");
  });
});
