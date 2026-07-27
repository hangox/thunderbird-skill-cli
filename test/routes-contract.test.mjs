// src/contracts/routes.ts 与 commands.ts 的静态契约断言。覆盖复核中反复
// 强调的几处具体事实：undo 的 CLI 命令路径、attachments.save 不接触任何
// 文件系统路径、attachments.fetch 的 JSON base64 分块常量与 no-route
// 死能力（delete/watch/calendar）保持为零。
import assert from "node:assert/strict";
import { test } from "node:test";
import { findCommand } from "../dist/contracts/commands.js";
import {
  ATTACHMENT_FETCH_MAX_CHUNK_ENCODED_BYTES,
  ATTACHMENT_FETCH_MAX_TOTAL_BYTES,
  ATTACHMENT_FETCH_TOKEN_TTL_MS,
  MAIL_CAPABILITIES,
  MAIL_ROUTES,
  findMailRoute,
  findMailRoutesByCommand,
} from "../dist/contracts/routes.js";

test("undo 的 CLI 命令路径是 operations undo，不是顶层 undo", () => {
  const command = findCommand(["operations", "undo", "undo_abc123"]);
  assert.ok(command, "operations undo 必须能被 findCommand 匹配");
  assert.deepEqual(command.path, ["operations", "undo"]);
  assert.equal(findCommand(["undo", "undo_abc123"]), undefined, "顶层 undo 不应再是合法命令");

  const route = MAIL_ROUTES.find((r) => r.id === "operations.undo");
  assert.ok(route);
  assert.deepEqual(route.command, ["operations", "undo"]);
  assert.equal(route.risk, "reversible");
  assert.equal(route.capability, "mail.reversible.v1");

  const byCommand = findMailRoutesByCommand(["operations", "undo"]);
  assert.equal(byCommand.length, 1);
  assert.equal(byCommand[0].id, "operations.undo");
});

test("attachments.save 的契约文本不再声称扩展会校验目标路径", () => {
  const route = MAIL_ROUTES.find((r) => r.id === "attachments.save");
  assert.ok(route);
  assert.doesNotMatch(route.summary, /校验目标路径/);
  assert.match(route.summary, /不接收也不校验任何本机文件系统路径/);
  assert.match(route.summary, /CLI（Task #36）负责/);
});

test("attachments.fetch 精确冻结 JSON base64 分块契约常量", () => {
  assert.equal(ATTACHMENT_FETCH_MAX_TOTAL_BYTES, 10 * 1024 * 1024);
  assert.equal(ATTACHMENT_FETCH_MAX_CHUNK_ENCODED_BYTES, 512 * 1024);
  assert.equal(ATTACHMENT_FETCH_TOKEN_TTL_MS, 2 * 60 * 1000);

  const route = MAIL_ROUTES.find((r) => r.id === "attachments.fetch");
  assert.ok(route);
  assert.match(route.summary, /不是原始二进制流/, "契约必须明确否认是原始二进制流，而不是含糊其辞");
  assert.match(route.summary, /JSON 内联 base64/);
  assert.match(route.summary, /不新增 HTTP 分支/);
  assert.match(route.summary, /cursor 严格单调续取/);
  // maxResponseBodyBytes 必须至少能装下一个满载的 base64 chunk（否则契约自相矛盾）。
  assert.ok(route.maxResponseBodyBytes >= ATTACHMENT_FETCH_MAX_CHUNK_ENCODED_BYTES);
});

test("attachments.save 与 attachments.fetch 都映射到同一个 CLI 命令 attachments save", () => {
  const byCommand = findMailRoutesByCommand(["attachments", "save"]);
  assert.deepEqual(byCommand.map((r) => r.id).sort(), ["attachments.fetch", "attachments.save"]);
});

test("delete/watch/calendar 在 MAIL_CAPABILITIES 与 MAIL_ROUTES 里保持零命中", () => {
  const deadCapabilities = ["mail.delete-confirmed.v1", "mail.watch.v1", "calendar.read.v1"];
  for (const capability of deadCapabilities) {
    assert.equal(MAIL_CAPABILITIES.includes(capability), false, capability);
  }
  const deadRouteIds = ["messages.delete.prepare", "messages.delete.confirm", "watch.poll"];
  for (const routeId of deadRouteIds) {
    assert.equal(MAIL_ROUTES.some((route) => route.id === routeId), false, routeId);
  }
  assert.equal(findMailRoute("POST", "/v1/mail/watch.poll"), undefined);
});

test("MAIL_ROUTES 里每个 id 唯一、path 唯一，且都在 MAIL_CAPABILITIES 声明范围内", () => {
  const ids = MAIL_ROUTES.map((route) => route.id);
  assert.equal(new Set(ids).size, ids.length, "route id 不得重复");
  const paths = MAIL_ROUTES.map((route) => route.path);
  assert.equal(new Set(paths).size, paths.length, "route path 不得重复");
  for (const route of MAIL_ROUTES) {
    assert.ok(MAIL_CAPABILITIES.includes(route.capability), `${route.id} 使用了未声明的 capability ${route.capability}`);
    assert.equal(route.method, "POST", `${route.id} 必须固定 POST`);
  }
});
