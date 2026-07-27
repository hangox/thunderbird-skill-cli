import assert from "node:assert/strict";
import { access, chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverInstances, parseDescriptor, resolveRuntimeRoot } from "../dist/discovery.js";

function descriptor(overrides = {}) {
  return {
    descriptorVersion: 2,
    protocolVersion: 1,
    instanceId: "inst_testabcd",
    profileId: `sha256:${"a".repeat(64)}`,
    profileLabel: "Fixture",
    pid: process.pid,
    port: 49152,
    sessionToken: "b".repeat(64),
    extensionVersion: "0.3.0",
    pairingEpoch: "0",
    startedAt: "2026-07-25T00:00:00.000Z",
    expiresAt: "2099-07-25T01:00:00.000Z",
    ...overrides,
  };
}

async function fixtureRoot(t) {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "tb-discovery-")));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await chmod(root, 0o700);
  await mkdir(join(root, "instances"), { mode: 0o700 });
  return root;
}

test("运行目录 override 必须是绝对路径", () => {
  assert.throws(() => resolveRuntimeRoot({ THUNDERBIRD_SKILL_RUNTIME_DIR: "relative" }), /绝对路径/);
});

test("descriptor 严格拒绝未知字段和过期数据", () => {
  assert.throws(() => parseDescriptor({ ...descriptor(), extra: true }), /未知字段/);
  assert.throws(() => parseDescriptor(descriptor({ expiresAt: "2026-07-24T00:00:00.000Z" }), Date.parse("2026-07-25T00:00:00.000Z")), /过期/);
});

test("安全目录和 0600 descriptor 可被发现", async (t) => {
  const root = await fixtureRoot(t);
  const path = join(root, "instances", "inst_testabcd.json");
  await writeFile(path, JSON.stringify(descriptor()), { mode: 0o600 });
  const result = await discoverInstances({ THUNDERBIRD_SKILL_RUNTIME_DIR: root });
  assert.equal(result.instances.length, 1);
  assert.equal(result.rejected.length, 0);
});

test("过期和不存在进程的 stale descriptor 会被安全清理", async (t) => {
  const root = await fixtureRoot(t);
  const expired = join(root, "instances", "inst_expired01.json");
  const dead = join(root, "instances", "inst_deadpid01.json");
  await writeFile(expired, JSON.stringify(descriptor({ instanceId: "inst_expired01", expiresAt: "2026-07-24T00:00:00.000Z" })), { mode: 0o600 });
  await writeFile(dead, JSON.stringify(descriptor({ instanceId: "inst_deadpid01", pid: 2147483647 })), { mode: 0o600 });
  const result = await discoverInstances({ THUNDERBIRD_SKILL_RUNTIME_DIR: root }, Date.parse("2026-07-25T00:00:00.000Z"));
  assert.equal(result.instances.length, 0);
  assert.equal(result.rejected.length, 2);
  await assert.rejects(access(expired));
  await assert.rejects(access(dead));
});

test("世界可读 descriptor 与 symlink 均失败关闭", async (t) => {
  const root = await fixtureRoot(t);
  const insecure = join(root, "instances", "inst_insecure1.json");
  await writeFile(insecure, JSON.stringify(descriptor({ instanceId: "inst_insecure1" })), { mode: 0o644 });
  const target = join(root, "target.json");
  await writeFile(target, JSON.stringify(descriptor({ instanceId: "inst_symlink01" })), { mode: 0o600 });
  await symlink(target, join(root, "instances", "inst_symlink01.json"));
  const result = await discoverInstances({ THUNDERBIRD_SKILL_RUNTIME_DIR: root });
  assert.equal(result.instances.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.ok(result.rejected.every((issue) => !issue.reason.includes(root)));
});
