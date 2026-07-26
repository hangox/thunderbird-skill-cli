import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { canonicalizeRequest as canonicalizeCli, createSigningIdentityInKeychain, deleteSigningIdentityFromKeychain, loadSigningIdentityFromKeychain, signRequest } from "../dist/auth.js";
import { NonceCache, ProtocolError, canonicalizeRequest, constantTimeTokenEqual, validateStatusRequest } from "../extension/dist/protocol.js";

const now = 1_753_430_400_000;
const token = "e".repeat(64);
const emptyBodySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function request(overrides = {}) {
  return {
    localAddress: "127.0.0.1",
    method: "GET",
    path: "/v1/status",
    host: "127.0.0.1:49152",
    contentType: "application/json",
    contentLength: "0",
    authorization: `Bearer ${token}`,
    clientName: "thunderbird-skill-cli",
    protocol: "1",
    clientVersion: "0.2.1",
    pairingEpoch: "0",
    requestId: "cli_123e4567-e89b-12d3-a456-426614174000",
    timestamp: String(now),
    nonce: "f".repeat(32),
    bodySha256: emptyBodySha256,
    ...overrides,
  };
}

test("session token 比较支持等长和异长失败", () => {
  assert.equal(constantTimeTokenEqual(token, token), true);
  assert.equal(constantTimeTokenEqual(token, "f".repeat(64)), false);
  assert.equal(constantTimeTokenEqual(token, token.slice(1)), false);
});

test("Host、Origin、timestamp、token 和 nonce 重放均失败关闭", async () => {
  const cases = [
    request({ host: "localhost:49152" }),
    request({ origin: "https://attacker.example" }),
    request({ timestamp: String(now - 31_000) }),
    request({ authorization: `Bearer ${"0".repeat(64)}` }),
  ];
  for (const candidate of cases) {
    await assert.rejects(validateStatusRequest({ request: candidate, expectedPort: 49152, sessionToken: token, pairingState: "unpaired", nonceCache: new NonceCache(), pairingEpoch: "0", nowMs: now }), ProtocolError);
  }
  const cache = new NonceCache();
  await validateStatusRequest({ request: request(), expectedPort: 49152, sessionToken: token, pairingState: "unpaired", nonceCache: cache, pairingEpoch: "0", nowMs: now });
  await assert.rejects(validateStatusRequest({ request: request(), expectedPort: 49152, sessionToken: token, pairingState: "unpaired", nonceCache: cache, pairingEpoch: "0", nowMs: now }), (error) => error.statusCode === 409);
});

test("配对状态要求有效 Ed25519 client 签名", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const unsigned = request({ clientId: "client_fixture01" });
  const cliCanonical = {
    method: unsigned.method, path: unsigned.path, host: unsigned.host, protocolVersion: 1,
    requestId: unsigned.requestId, timestamp: unsigned.timestamp, nonce: unsigned.nonce, bodySha256: unsigned.bodySha256,
    pairingEpoch: unsigned.pairingEpoch,
  };
  assert.equal(canonicalizeCli(cliCanonical), canonicalizeRequest(unsigned));
  const signed = { ...unsigned, signature: signRequest(cliCanonical, { clientId: unsigned.clientId, publicKeyAlgorithm: "Ed25519", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) }) };
  const client = { clientId: unsigned.clientId, publicKeyAlgorithm: "Ed25519", publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
  await validateStatusRequest({ request: signed, expectedPort: 49152, sessionToken: token, pairingState: "paired", client, nonceCache: new NonceCache(), pairingEpoch: "0", nowMs: now });
  await assert.rejects(validateStatusRequest({ request: { ...signed, signature: "bad" }, expectedPort: 49152, sessionToken: token, pairingState: "paired", client, nonceCache: new NonceCache(), pairingEpoch: "0", nowMs: now }), (error) => error.statusCode === 401);
});

test("未来时间请求的 nonce 在完整接受窗口内仍不可重放", async () => {
  const futureTimestamp = now + 29_000;
  const candidate = request({ timestamp: String(futureTimestamp), nonce: "a".repeat(32) });
  const cache = new NonceCache();
  await validateStatusRequest({ request: candidate, expectedPort: 49152, sessionToken: token, pairingState: "unpaired", nonceCache: cache, pairingEpoch: "0", nowMs: now });
  await assert.rejects(
    validateStatusRequest({ request: candidate, expectedPort: 49152, sessionToken: token, pairingState: "unpaired", nonceCache: cache, pairingEpoch: "0", nowMs: now + 31_000 }),
    (error) => error.statusCode === 409,
  );
});

test("macOS Keychain 中的 Ed25519 client 身份可稳定创建、加载与删除", { skip: process.platform !== "darwin" }, async (t) => {
  const clientId = `client_test_${process.pid}_${Date.now()}`;
  await deleteSigningIdentityFromKeychain(clientId);
  t.after(() => deleteSigningIdentityFromKeychain(clientId));
  const created = await createSigningIdentityInKeychain(clientId);
  assert.ok(created);
  assert.match(created.publicKeySpkiBase64, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(created.publicKeySpkiBase64, "base64").length, 44);
  const loaded = await loadSigningIdentityFromKeychain(clientId);
  assert.equal(loaded?.clientId, clientId);
  assert.equal(loaded?.publicKeySpkiBase64, created.publicKeySpkiBase64);
  assert.equal(await deleteSigningIdentityFromKeychain(clientId), true);
  assert.equal(await loadSigningIdentityFromKeychain(clientId), undefined);
});

test("无效 token 在 route 与 Content-Type 校验前统一认证失败", async () => {
  const candidate = request({
    authorization: `Bearer ${"0".repeat(64)}`,
    method: "POST",
    path: "/v1/unknown",
    contentType: "text/plain",
    contentLength: "12",
    bodySha256: "0".repeat(64),
  });
  await assert.rejects(
    validateStatusRequest({ request: candidate, expectedPort: 49152, sessionToken: token, pairingState: "unpaired", nonceCache: new NonceCache(), pairingEpoch: "0", nowMs: now }),
    (error) => error.statusCode === 401 && error.message === "认证失败",
  );
});

test("协议层在验签之前就以 E_VERSION_MISMATCH 拒绝不兼容 CLI 版本", async () => {
  await assert.rejects(
    validateStatusRequest({ request: request({ clientVersion: "0.1.0" }), expectedPort: 49152, sessionToken: token, pairingState: "unpaired", nonceCache: new NonceCache(), pairingEpoch: "0", nowMs: now }),
    (error) => error.statusCode === 426 && error.code === "E_VERSION_MISMATCH",
  );
});

test("协议层 pairingEpoch 格式非法 401、值失配 409 E_PAIRING_CHANGED", async () => {
  for (const value of ["007", "+7", "0x10", "1e3", "1.5", " 7", "-1", "", "1".repeat(17)]) {
    await assert.rejects(
      validateStatusRequest({ request: request({ pairingEpoch: value }), expectedPort: 49152, sessionToken: token, pairingState: "unpaired", nonceCache: new NonceCache(), pairingEpoch: "0", nowMs: now }),
      (error) => error.statusCode === 401,
      `epoch=${JSON.stringify(value)}`,
    );
  }
  await assert.rejects(
    validateStatusRequest({ request: request({ pairingEpoch: "1" }), expectedPort: 49152, sessionToken: token, pairingState: "unpaired", nonceCache: new NonceCache(), pairingEpoch: "0", nowMs: now }),
    (error) => error.statusCode === 409 && error.code === "E_PAIRING_CHANGED",
  );
});

test("协议层 canonical 覆盖 pairingEpoch", () => {
  const base = request({ pairingEpoch: "0" });
  assert.notEqual(canonicalizeRequest(base), canonicalizeRequest({ ...base, pairingEpoch: "1" }));
  assert.equal(canonicalizeRequest(base).split("\n").at(-1), "0");
});
