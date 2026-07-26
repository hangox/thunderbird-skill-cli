import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(projectRoot, "extension");
const members = [
  "dist/protocol.js",
  "dist/background.js",
  "dist/options.js",
  "bridge/schema.json",
  "bridge/api.js",
  "manifest.json",
  "options.html",
];
const outputPath = resolve(process.argv[2] ?? resolve(projectRoot, "thunderbird-skill-bridge-phase1.xpi"));
const temporaryOutput = resolve(dirname(outputPath), `.${basename(outputPath)}.${process.pid}.${randomUUID()}.xpi`);
const fixedTimestamp = new Date("2000-01-01T00:00:00.000Z");

const originalTimes = await Promise.all(members.map(async (member) => {
  const path = resolve(extensionRoot, member);
  const metadata = await stat(path);
  return { path, atime: metadata.atime, mtime: metadata.mtime };
}));

try {
  await Promise.all(originalTimes.map(({ path }) => utimes(path, fixedTimestamp, fixedTimestamp)));
  await execFileAsync("/usr/bin/zip", ["-X", "-q", temporaryOutput, ...members], {
    cwd: extensionRoot,
    env: { ...process.env, TZ: "UTC" },
  });
  await rename(temporaryOutput, outputPath);
} finally {
  await Promise.all(originalTimes.map(({ path, atime, mtime }) => utimes(path, atime, mtime)));
  await unlink(temporaryOutput).catch(() => undefined);
}
