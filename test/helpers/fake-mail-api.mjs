// 邮件 route 的精简假服务端，专供 CLI 侧（src/cli.ts + args/input/output/session）
// 测试使用。
//
// 与 test/helpers/experiment-harness.mjs 刻意分工不同：experiment-harness 跑
// 真实 extension/bridge/api.js 验证扩展侧的签名/capability/反原型污染管线；
// 这里完全不做那些校验（真实签名头会被发送但不被验证），只按调用方配置的
// `routeHandlers` 返回canned 响应——因为要验证的是 CLI 自己的职责：请求怎么
// 拼、--input/--confirm 怎么读、成功/错误怎么映射成 envelope 与退出码。两者
// 一起才覆盖"CLI 请求构造是否正确"与"扩展是否正确执行/拒绝"两侧。
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_STATUS = {
  protocolVersion: 1,
  minCliVersion: "0.3.0",
  maxCliVersion: "0.3.0",
  extensionVersion: "0.3.0",
  pairingState: "paired",
  pairingEpoch: "0",
  capabilities: ["mail.read.v1", "mail.reversible.v1", "draft.write.v1", "mail.send-confirmed.v1"],
  authorizedAccountRefs: [],
};

function respond(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * @param {import("node:test").TestContext} t
 * @param {{statusOverrides?: object, routeHandlers?: Record<string, (body: any) => {status?: number, body: any}>, instanceId?: string, profileId?: string}} [options]
 */
export async function startFakeMailApi(t, options = {}) {
  const instanceId = options.instanceId ?? "inst_fake_mail1";
  const profileId = options.profileId ?? `sha256:${"4".repeat(64)}`;
  const routeHandlers = options.routeHandlers ?? {};
  const requests = [];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try { body = bodyText ? JSON.parse(bodyText) : {}; } catch { body = {}; }
      requests.push({ method: req.method, url: req.url, body });

      if (req.method === "GET" && req.url === "/v1/status") {
        respond(res, 200, { instanceId, profileId, ...DEFAULT_STATUS, ...(options.statusOverrides ?? {}) });
        return;
      }
      const handler = routeHandlers[req.url];
      if (!handler) { respond(res, 501, { error: { code: "E_NOT_IMPLEMENTED", message: "该邮件能力尚未实现" } }); return; }
      const result = handler(body);
      respond(res, result.status ?? 200, result.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const root = await mkdtemp(join(tmpdir(), "tb-fake-mail-"));
  await chmod(root, 0o700);
  await mkdir(join(root, "instances"), { mode: 0o700 });
  await writeFile(join(root, "instances", `${instanceId}.json`), JSON.stringify({
    descriptorVersion: 2,
    protocolVersion: 1,
    instanceId,
    profileId,
    profileLabel: "Fake Mail Fixture",
    pid: process.pid,
    port: address.port,
    sessionToken: "5".repeat(64),
    extensionVersion: "0.3.0",
    pairingEpoch: "0",
    startedAt: "2026-07-25T00:00:00.000Z",
    expiresAt: "2099-07-25T01:00:00.000Z",
  }), { mode: 0o600 });
  t.after(async () => rm(root, { recursive: true, force: true }));

  return { root, requests, port: address.port };
}
