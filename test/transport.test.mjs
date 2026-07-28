import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { beginPairing, fetchPairingIntent, fetchStatus } from "../dist/transport.js";

async function serverFixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  return address.port;
}

function descriptor(port, overrides = {}) {
  return {
    descriptorVersion: 2,
    protocolVersion: 1,
    instanceId: "inst_transport1",
    profileId: `sha256:${"c".repeat(64)}`,
    profileLabel: "Fixture",
    pid: process.pid,
    port,
    sessionToken: "d".repeat(64),
    extensionVersion: "0.4.0",
    pairingEpoch: "0",
    startedAt: "2026-07-25T00:00:00.000Z",
    expiresAt: "2099-07-25T01:00:00.000Z",
    ...overrides,
  };
}

function status(overrides = {}) {
  return {
    protocolVersion: 1,
    minCliVersion: "0.4.0",
    maxCliVersion: "0.4.0",
    extensionVersion: "0.4.0",
    instanceId: "inst_transport1",
    profileId: `sha256:${"c".repeat(64)}`,
    capabilities: [],
    pairingState: "unpaired",
    pairingEpoch: "0",
    authorizedAccountRefs: [],
    ...overrides,
  };
}

test("status 仅调用数值回环且发送安全头", async (t) => {
  const port = await serverFixture(t, (request, response) => {
    assert.equal(request.headers.host, `127.0.0.1:${port}`);
    assert.equal(request.headers.authorization, `Bearer ${"d".repeat(64)}`);
    assert.equal(request.headers["x-thunderbird-protocol"], "1");
    assert.equal(request.headers["x-thunderbird-pairing-epoch"], "0");
    assert.equal(request.headers["x-thunderbird-client-version"], "0.4.0");
    assert.match(request.headers["x-request-nonce"], /^[a-f0-9]{32}$/);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(status()));
  });
  const result = await fetchStatus(descriptor(port), 1000);
  assert.equal(result.pairingState, "unpaired");
});

test("传入 signing identity 时请求包含 Ed25519 client 头", async (t) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const port = await serverFixture(t, (request, response) => {
    assert.equal(request.headers["x-thunderbird-client-id"], "client_fixture01");
    assert.equal(request.headers["x-thunderbird-signature-algorithm"], undefined);
    assert.match(request.headers["x-request-signature"], /^[A-Za-z0-9+/]+=*$/);
    assert.equal(request.headers["x-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(status()));
  });
  await fetchStatus(descriptor(port), 1000, {
    clientId: "client_fixture01",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
});

test("pairing intent 使用带 body hash 的 Ed25519 请求并严格解析状态", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity = {
    clientId: "client_fixture01",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  const intentId = `intent_${"a".repeat(32)}`;
  let pollPath;
  const port = await serverFixture(t, (request, response) => {
    assert.match(request.headers["x-content-sha256"], /^[a-f0-9]{64}$/);
    assert.match(request.headers["x-request-signature"], /^[A-Za-z0-9+/]+=*$/);
    if (request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(body.clientId, identity.clientId);
        assert.equal(Object.keys(body).sort().join(","), "clientId,publicKeyAlgorithm,publicKeySpkiBase64");
        assert.equal(body.publicKeyAlgorithm, "Ed25519");
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ intentId, challengeCode: "123456", clientId: identity.clientId, expiresAt: "2099-07-25T01:00:00.000Z", pairingState: "pairing" }));
      });
      return;
    }
    pollPath = request.url;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ intentId, pairingState: "paired", clientId: identity.clientId, expiresAt: "2099-07-25T01:00:00.000Z" }));
  });
  const intent = await beginPairing(descriptor(port), 1000, identity);
  assert.equal(intent.challengeCode, "123456");
  const pairing = await fetchPairingIntent(descriptor(port), 1000, intentId, identity);
  assert.equal(pairing.pairingState, "paired");
  assert.equal(pollPath, `/v1/pairing/intents/${intentId}`);
});

test("pairing intent 响应已经过期时失败关闭", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity = {
    clientId: "client_expired01",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  const port = await serverFixture(t, (request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        intentId: `intent_${"e".repeat(32)}`,
        challengeCode: "123456",
        clientId: identity.clientId,
        expiresAt: "2000-01-01T00:00:00.000Z",
        pairingState: "pairing",
      }));
    });
  });
  await assert.rejects(beginPairing(descriptor(port), 1000, identity), (error) => error.code === "E_VALIDATION" && /已过期/.test(error.message));
});

test("status 身份不一致和协议不兼容时失败关闭", async (t) => {
  const identityPort = await serverFixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(status({ instanceId: "inst_attacker1" })));
  });
  await assert.rejects(fetchStatus(descriptor(identityPort), 1000), (error) => error.code === "E_AUTH");

  const versionPort = await serverFixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(status({ protocolVersion: 3 })));
  });
  await assert.rejects(fetchStatus(descriptor(versionPort), 1000), (error) => error.code === "E_VERSION_MISMATCH");
});

test("认证拒绝映射为 E_AUTH", async (t) => {
  const port = await serverFixture(t, (_request, response) => {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await assert.rejects(fetchStatus(descriptor(port), 1000), (error) => error.code === "E_AUTH");
});

for (const conflict of [
      { serverCode: "E_REPLAY", cliCode: "E_REPLAY", message: /重复 nonce/ },
      { serverCode: "E_PAIRING_PENDING", cliCode: "E_PAIRING_PENDING", message: /完成或拒绝/ },
      { serverCode: "E_ALREADY_PAIRED", cliCode: "E_ALREADY_PAIRED", message: /显式撤销/ },
    ]) {
      test("HTTP 409 " + conflict.serverCode + " 保留稳定机器码与恢复指引", async (t) => {
        const port = await serverFixture(t, (_request, response) => {
          response.writeHead(409, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { code: conflict.serverCode, message: "服务端诊断" } }));
        });
        await assert.rejects(
          fetchStatus(descriptor(port), 1000),
          (error) => error.code === conflict.cliCode && conflict.message.test(error.message) && error.retryable === false,
        );
      });
    }
    
    test("未知或畸形 HTTP 409 响应失败关闭", async (t) => {
      const unknownPort = await serverFixture(t, (_request, response) => {
        response.writeHead(409, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: "E_REJECTED", message: "未知冲突" } }));
      });
      await assert.rejects(fetchStatus(descriptor(unknownPort), 1000), (error) => error.code === "E_VALIDATION" && /未知请求状态冲突/.test(error.message));
    
      const malformedPort = await serverFixture(t, (_request, response) => {
        response.writeHead(409, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: "E_REPLAY" } }));
      });
      await assert.rejects(fetchStatus(descriptor(malformedPort), 1000), (error) => error.code === "E_VALIDATION" && /格式不合法/.test(error.message));
    });

test("总 deadline 不会被持续小数据绕过", async (t) => {
  const port = await serverFixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    const interval = setInterval(() => response.write(" "), 50);
    response.on("close", () => clearInterval(interval));
  });
  const startedAt = Date.now();
  await assert.rejects(fetchStatus(descriptor(port), 250), (error) => error.code === "E_TIMEOUT");
  assert.ok(Date.now() - startedAt < 750);
});

test("严格拒绝 JSONP Content-Type 与未知 capability", async (t) => {
  const jsonpPort = await serverFixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/jsonp" });
    response.end(JSON.stringify(status()));
  });
  await assert.rejects(fetchStatus(descriptor(jsonpPort), 1000), (error) => error.code === "E_VALIDATION");

  const capabilityPort = await serverFixture(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(status({ capabilities: ["unknown.v1"] })));
  });
  await assert.rejects(fetchStatus(descriptor(capabilityPort), 1000), (error) => error.code === "E_VALIDATION");
});
