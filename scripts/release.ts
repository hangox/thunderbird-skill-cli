import { execFileSync, spawnSync } from "node:child_process";
import { cp, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = path.join(root, "package.json");
const lockPath = path.join(root, "package-lock.json");
const manifestPath = path.join(root, "extension", "manifest.json");
const protocolPath = path.join(root, "extension", "src", "protocol.ts");
const transportPath = path.join(root, "src", "transport.ts");
const apiPath = path.join(root, "extension", "bridge", "api.js");
const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");
const distributionPath = path.join(process.env.HOME ?? "/Users/hangox", "thunderbird-addons-dist", "skill-bridge", "latest.xpi");

const packageJson = await readJson<{ version: string }>(packagePath);
const version = process.argv[2] ?? incrementPatch(packageJson.version);
assertVersion(version);

if (version !== packageJson.version) {
  await updateVersions(packageJson.version, version);
  console.log(`版本：${packageJson.version} -> ${version}`);
} else {
  console.log(`版本保持为 ${version}`);
}

execFileSync("npm", ["run", "package:extension"], { cwd: root, stdio: "inherit" });
await cp(path.join(root, "thunderbird-skill-bridge-phase1.xpi"), distributionPath, { force: true });
console.log(`已更新分发包：${distributionPath}`);

const releaseFiles = [
  "package.json",
  "package-lock.json",
  "extension/manifest.json",
  "extension/src/protocol.ts",
  "src/transport.ts",
  "extension/bridge/api.js",
  ".claude-plugin/marketplace.json",
  "scripts/release.ts",
];
execFileSync("git", ["add", ...releaseFiles], { cwd: root, stdio: "inherit" });
if (hasStagedChanges()) {
  execFileSync("git", ["commit", "-m", `release: skill bridge v${version}`], { cwd: root, stdio: "inherit" });
  execFileSync("git", ["push"], { cwd: root, stdio: "inherit" });
} else {
  console.log("发布元数据没有变更，跳过提交与推送。");
}

async function updateVersions(currentVersion: string, nextVersion: string): Promise<void> {
  const lock = await readJson<Record<string, unknown>>(lockPath);
  const manifest = await readJson<Record<string, unknown>>(manifestPath);
  const marketplace = await readJson<Record<string, unknown>>(marketplacePath);
  const files = [protocolPath, transportPath, apiPath];

  packageJson.version = nextVersion;
  lock.version = nextVersion;
  const packages = lock.packages;
  if (typeof packages === "object" && packages !== null) {
    const packageEntries = packages as Record<string, unknown>;
    if (typeof packageEntries[""] === "object" && packageEntries[""] !== null) {
      (packageEntries[""] as Record<string, unknown>).version = nextVersion;
    }
  }
  manifest.version = nextVersion;
  replaceVersionInMarketplace(marketplace, currentVersion, nextVersion);

  await writeJson(packagePath, packageJson);
  await writeJson(lockPath, lock);
  await writeJson(manifestPath, manifest);
  await Promise.all(files.map(async file => {
    const source = await readFile(file, "utf8");
    const updated = replaceExactVersion(source, currentVersion, nextVersion, file);
    await writeTextAtomically(file, updated);
  }));
  await writeJson(marketplacePath, marketplace);
}

function replaceVersionInMarketplace(value: unknown, currentVersion: string, nextVersion: string): void {
  const serialized = JSON.stringify(value);
  if (!serialized.includes(currentVersion)) throw new Error(`marketplace.json 未包含当前版本 ${currentVersion}`);
  const replace = (input: unknown): unknown => {
    if (typeof input === "string") return input === currentVersion ? nextVersion : input;
    if (Array.isArray(input)) return input.map(replace);
    if (typeof input === "object" && input !== null) {
      return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, replace(child)]));
    }
    return input;
  };
  Object.assign(value as Record<string, unknown>, replace(value) as Record<string, unknown>);
}

function replaceExactVersion(source: string, currentVersion: string, nextVersion: string, file: string): string {
  const pattern = new RegExp(`(?<=['\"])${escapeRegExp(currentVersion)}(?=['\"])`, "g");
  const matches = source.match(pattern)?.length ?? 0;
  if (matches === 0) throw new Error(`${file} 未包含当前版本 ${currentVersion}`);
  return source.replace(pattern, nextVersion);
}

function hasStagedChanges(): boolean {
  return spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root }).status !== 0;
}

function incrementPatch(current: string): string {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`无法自动递增非语义版本：${current}；请显式传入新版本号。`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function assertVersion(value: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`版本号必须为 X.Y.Z：${value}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeTextAtomically(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(file: string, value: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, file);
}
