// src/paths.ts 的执行级单元测试：附件安全落盘的核心不变量。
//
// 覆盖 Task #36 要求的负向路径类别：路径穿越、symlink、设备/管道文件、
// 敏感系统路径、已存在（no-clobber）、相对路径，以及原子发布的长度/摘要
// 校验与失败清理（不留半成品）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  openAttachmentTempFile,
  resolveSafeDestination,
  resolveSafeDirectory,
  sanitizeAttachmentFileName,
} from "../dist/paths.js";

// os.tmpdir() 在 macOS 上经由 /var -> /private/var 这层系统级 symlink；
// resolveSafeDirectory 内部用 fs.realpath 解析规范路径，返回值会是
// /private/var/... 而不是字面的 /var/...。测试里统一在创建后立刻 realpath
// 一次，让 root 与被测函数返回的规范路径保持一致，避免测试断言因这层无关
// 的系统级 symlink 而误报。
async function makeRoot(t) {
  const created = await mkdtemp(join(tmpdir(), "tb-paths-"));
  await chmod(created, 0o700);
  const root = await realpath(created);
  t.after(() => rm(created, { recursive: true, force: true }));
  return root;
}

function sha256Digest(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

// --- sanitizeAttachmentFileName ---------------------------------------------

test("文件名规范化：拒绝路径分隔符、空、./..、超长", () => {
  assert.equal(sanitizeAttachmentFileName("report.pdf"), "report.pdf");
  for (const bad of ["a/b", "a\\b", "", "   ", ".", "..", "x".repeat(256)]) {
    assert.throws(() => sanitizeAttachmentFileName(bad), /E_VALIDATION|不合法|过长|路径分隔符/, JSON.stringify(bad));
  }
  assert.throws(() => sanitizeAttachmentFileName(123));
});

// --- resolveSafeDirectory ----------------------------------------------------

test("目标目录必须是绝对路径，拒绝相对路径", async () => {
  await assert.rejects(resolveSafeDirectory("relative/dir"), /绝对路径/);
  await assert.rejects(resolveSafeDirectory(""), /绝对路径/);
  await assert.rejects(resolveSafeDirectory(42));
});

test("目标目录拒绝敏感系统路径（realpath 解析后判定，而不是字面字符串）", async () => {
  await assert.rejects(resolveSafeDirectory("/etc"), /敏感系统路径/); // macOS 上 /etc 本身是指向 /private/etc 的系统级 symlink
  await assert.rejects(resolveSafeDirectory("/System/Library"), /敏感系统路径/);
  // 路径穿越：字面上不是 /etc，但真实存在的 .. 组件折叠后落在 /etc 之下
  // （/private/tmp 真实存在，是合法的路径写法，不是伪造的字符串）。
  await assert.rejects(resolveSafeDirectory("/private/tmp/../etc"), /敏感系统路径/);
});

test("目标目录不存在时失败关闭", async (t) => {
  const root = await makeRoot(t);
  await assert.rejects(resolveSafeDirectory(join(root, "not-exist")), /不存在/);
});

test("目标目录路径含 symlink 时跟随解析（如 macOS /tmp -> /private/tmp），只要解析后的规范位置本身安全就允许", async (t) => {
  const root = await makeRoot(t);
  const real = join(root, "real");
  await mkdir(real, { mode: 0o700 });
  const link = join(root, "link-to-real");
  await symlink(real, link);

  // 与 makeRoot() 本身依赖 os.tmpdir()（macOS 上经由 /var -> /private/var）
  // 完全一致的场景：目录链路里有系统级 symlink 不应被拒绝，只要最终落点安全。
  const resolvedViaLink = await resolveSafeDirectory(link);
  const resolvedDirect = await resolveSafeDirectory(real);
  assert.equal(resolvedViaLink, resolvedDirect, "通过 symlink 与直接访问真实目录应解析到同一个规范路径");
});

test("symlink 解析后落在敏感系统路径时拒绝（防止用 symlink 绕过敏感路径检查）", async (t) => {
  const root = await makeRoot(t);
  const sneaky = join(root, "sneaky-link");
  await symlink("/private/etc", sneaky);
  await assert.rejects(resolveSafeDirectory(sneaky), /敏感系统路径/);
});

test("悬空 symlink（指向不存在目标）作为目标目录时失败关闭", async (t) => {
  const root = await makeRoot(t);
  const dangling = join(root, "dangling-dir-link");
  await symlink(join(root, "does-not-exist"), dangling);
  await assert.rejects(resolveSafeDirectory(dangling), /不存在/);
});

test("目标目录是设备/管道/套接字文件时拒绝（用 FIFO 模拟特殊文件类型）", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await makeRoot(t);
  const fifoPath = join(root, "a-fifo");
  execFileSync("mkfifo", [fifoPath]);
  await assert.rejects(resolveSafeDirectory(fifoPath), /设备\/管道\/套接字/);
});

test("目标目录本身不是真实目录（是普通文件）时拒绝", async (t) => {
  const root = await makeRoot(t);
  const filePath = join(root, "not-a-dir");
  await writeFile(filePath, "x");
  await assert.rejects(resolveSafeDirectory(filePath), /目标目录不是真实目录|上级不是真实目录/);
});

// --- resolveSafeDestination（no-clobber 预检查） ----------------------------

test("目标文件已存在（含悬空 symlink）时拒绝覆盖", async (t) => {
  const root = await makeRoot(t);
  await writeFile(join(root, "exists.txt"), "old content");
  await assert.rejects(resolveSafeDestination(root, "exists.txt"), /已存在/);

  // 悬空 symlink：目标本身不存在，但 exists.txt 位置有一个指向不存在文件的
  // symlink——lstat（而不是 stat）必须仍然判定为"已存在"并拒绝。
  await symlink(join(root, "does-not-exist-target"), join(root, "dangling-link"));
  await assert.rejects(resolveSafeDestination(root, "dangling-link"), /已存在/);
});

test("目标目录安全但文件不存在时通过预检查", async (t) => {
  const root = await makeRoot(t);
  const result = await resolveSafeDestination(root, "fresh.txt");
  assert.equal(result.finalPath, join(root, "fresh.txt"));
});

// --- openAttachmentTempFile：原子发布 + 失败清理 ----------------------------

async function listTempParts(directory) {
  const entries = await readdir(directory);
  return entries.filter((name) => name.includes(".thunderbird-skill-") && name.endsWith(".part"));
}

test("附件写入成功：内容落盘、摘要匹配、临时文件被清理", async (t) => {
  const root = await makeRoot(t);
  const content = Buffer.from("hello attachment content, chunked across calls");
  const handle = await openAttachmentTempFile(root, "greeting.txt");
  await handle.write(content.subarray(0, 10));
  await handle.write(content.subarray(10));
  const result = await handle.finish({ totalBytes: content.length, sha256Digest: sha256Digest(content) });
  assert.equal(result.finalPath, join(root, "greeting.txt"));
  assert.equal(result.bytesWritten, content.length);
  const written = await readFile(result.finalPath);
  assert.deepEqual(written, content);
  assert.deepEqual(await listTempParts(root), []);
});

test("长度不匹配：finish 拒绝并清理临时文件，不留半成品，最终文件不存在", async (t) => {
  const root = await makeRoot(t);
  const handle = await openAttachmentTempFile(root, "short.txt");
  await handle.write(Buffer.from("only 4 bytes写"));
  await assert.rejects(handle.finish({ totalBytes: 999, sha256Digest: "sha256:" + "0".repeat(64) }), /长度不匹配/);
  assert.deepEqual(await listTempParts(root), []);
  await assert.rejects(readFile(join(root, "short.txt")), /ENOENT/);
});

test("摘要不匹配：finish 拒绝并清理临时文件", async (t) => {
  const root = await makeRoot(t);
  const content = Buffer.from("digest mismatch test content");
  const handle = await openAttachmentTempFile(root, "mismatch.bin");
  await handle.write(content);
  await assert.rejects(
    handle.finish({ totalBytes: content.length, sha256Digest: "sha256:" + "f".repeat(64) }),
    /摘要不匹配/,
  );
  assert.deepEqual(await listTempParts(root), []);
  await assert.rejects(readFile(join(root, "mismatch.bin")), /ENOENT/);
});

test("abort() 清理未完成的临时文件，不发布任何内容", async (t) => {
  const root = await makeRoot(t);
  const handle = await openAttachmentTempFile(root, "aborted.bin");
  await handle.write(Buffer.from("partial data that should never be published"));
  await handle.abort();
  assert.deepEqual(await listTempParts(root), []);
  await assert.rejects(readFile(join(root, "aborted.bin")), /ENOENT/);
});

test("发布时目标已被并发创建（TOCTOU 竞态）：link() 原子失败，拒绝覆盖且清理临时文件", async (t) => {
  const root = await makeRoot(t);
  const content = Buffer.from("race condition content");
  const handle = await openAttachmentTempFile(root, "race.bin");
  await handle.write(content);
  // 模拟"预检查通过之后、finish 之前"目标被别的进程/请求创建——finish() 的
  // link() 必须原子失败，不能静默覆盖已存在的真实内容。
  await writeFile(join(root, "race.bin"), "concurrently created, must not be overwritten");
  await assert.rejects(handle.finish({ totalBytes: content.length, sha256Digest: sha256Digest(content) }), /已存在/);
  assert.deepEqual(await listTempParts(root), []);
  const surviving = await readFile(join(root, "race.bin"), "utf8");
  assert.equal(surviving, "concurrently created, must not be overwritten", "并发创建的真实内容不得被覆盖");
});

test("同名文件不能覆盖：先成功发布一次，第二次对同名文件的操作在预检查阶段就被拒绝", async (t) => {
  const root = await makeRoot(t);
  const content = Buffer.from("first write");
  const first = await openAttachmentTempFile(root, "once.bin");
  await first.write(content);
  await first.finish({ totalBytes: content.length, sha256Digest: sha256Digest(content) });

  await assert.rejects(openAttachmentTempFile(root, "once.bin"), /已存在/);
  const surviving = await readFile(join(root, "once.bin"), "utf8");
  assert.equal(surviving, "first write");
});
