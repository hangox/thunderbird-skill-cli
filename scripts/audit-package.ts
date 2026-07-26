// 对最终 npm tarball 做发布前审计。
//
// 采用**白名单 + 敏感模式**双重判定：既确认"只有预期文件"，也确认
// "没有任何敏感内容"。任一不通过即非零退出，用于 CI 硬门禁。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = resolve(projectRoot, "build", "plugin");

/** 允许出现在 tarball 中的文件（精确路径或前缀目录）。 */
const ALLOWED_EXACT = new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "NOTICE",
  ".claude-plugin/plugin.json",
  "bin/thunderbird.js",
  "assets/thunderbird-skill-bridge.xpi",
]);
const ALLOWED_PREFIXES = ["dist/", "skills/"];

/** 任何一条命中即判定为敏感内容泄漏。 */
const FORBIDDEN_CONTENT: Array<{ name: string; pattern: RegExp }> = [
  { name: "私钥 / 证书块", pattern: /BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY|BEGIN CERTIFICATE/ },
  { name: "npm / GitHub / AWS token", pattern: /\bnpm_[A-Za-z0-9]{36}\b|\bgh[pousr]_[A-Za-z0-9]{36}\b|\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Apple 签名标识", pattern: /TeamIdentifier|ApplicationIdentifierPrefix|keychain-access-groups/ },
  { name: "个人绝对路径", pattern: /\/Users\/(?!me\b)[A-Za-z0-9._-]+/ },
  { name: "环境变量凭据赋值", pattern: /(?:_authToken|NPM_TOKEN|GITHUB_TOKEN)\s*=\s*\S+/ },
];

/** 明确不允许出现的路径片段。 */
const FORBIDDEN_PATHS = [
  { name: "native 存档", test: (p: string) => p.startsWith("native/") },
  { name: "provisioning / 代码签名", test: (p: string) => /provisionprofile|mobileprovision|CodeResources|embedded\.pro/i.test(p) },
  { name: "测试与 profile", test: (p: string) => p.startsWith("test/") || /\.test\.mjs$/.test(p) },
  { name: "descriptor 运行时产物", test: (p: string) => /instances\/|\.descriptor\.json$/.test(p) },
  { name: "环境变量文件", test: (p: string) => /(^|\/)\.env(\.|$)/.test(p) },
  { name: "node_modules", test: (p: string) => p.includes("node_modules/") },
  { name: "source map / 类型声明", test: (p: string) => p.endsWith(".map") || p.endsWith(".d.ts") },
];

const TEXT_EXTENSIONS = new Set([".js", ".json", ".md", ".mjs", ".ts", ".txt", ".html", ".yml", ".yaml"]);

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "tb-audit-"));
  let failures = 0;
  const fail = (message: string): void => { failures += 1; process.stdout.write(`  ✘ ${message}\n`); };

  try {
    // 真实打包（不是 --dry-run），审计的是实际会被上传的 tarball
    const { stdout } = await execFileAsync("npm", ["pack", "--pack-destination", workDir, "--json"], { cwd: stagingRoot, maxBuffer: 8 * 1024 * 1024 });
    const meta = JSON.parse(stdout) as Array<{ filename: string; files: Array<{ path: string }>; size: number; unpackedSize: number }>;
    const entry = meta[0];
    if (!entry) throw new Error("npm pack 未返回结果");
    const tarball = join(workDir, entry.filename);
    const sha = createHash("sha256").update(await readFile(tarball)).digest("hex");

    process.stdout.write(`tarball：${entry.filename}\n`);
    process.stdout.write(`打包大小：${(entry.size / 1024).toFixed(1)} KiB，解包后 ${(entry.unpackedSize / 1024).toFixed(1)} KiB\n`);
    process.stdout.write(`SHA-256：${sha}\n\n`);

    const paths = entry.files.map((f) => f.path).sort();
    process.stdout.write(`文件清单（${paths.length}）：\n`);
    for (const p of paths) process.stdout.write(`  ${p}\n`);
    process.stdout.write("\n审计结果：\n");

    // 1. 白名单
    for (const p of paths) {
      if (!ALLOWED_EXACT.has(p) && !ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix))) {
        fail(`非白名单文件：${p}`);
      }
    }
    // 2. 禁止路径
    for (const p of paths) {
      for (const rule of FORBIDDEN_PATHS) if (rule.test(p)) fail(`${rule.name}：${p}`);
    }
    // 3. 必需文件
    for (const required of ALLOWED_EXACT) {
      if (!paths.includes(required)) fail(`缺少必需文件：${required}`);
    }
    if (!paths.some((p) => p.startsWith("skills/thunderbird/"))) fail("缺少 skills/thunderbird/");

    // 4. 文本内容敏感扫描
    await execFileAsync("/usr/bin/tar", ["-xzf", tarball, "-C", workDir]);
    const unpacked = join(workDir, "package");
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) out.push(...await walk(full));
        else out.push(full);
      }
      return out;
    };
    for (const file of await walk(unpacked)) {
      const rel = relative(unpacked, file);
      const ext = file.slice(file.lastIndexOf("."));
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      const text = await readFile(file, "utf8");
      for (const rule of FORBIDDEN_CONTENT) {
        const hit = rule.pattern.exec(text);
        if (hit) fail(`${rule.name} 出现在 ${rel}：${hit[0].slice(0, 60)}`);
      }
    }

    // 5. XPI 与源码冻结件一致
    const packagedXpi = createHash("sha256").update(await readFile(join(unpacked, "assets", "thunderbird-skill-bridge.xpi"))).digest("hex");
    const frozenXpi = createHash("sha256").update(await readFile(resolve(projectRoot, "thunderbird-skill-bridge-phase1.xpi"))).digest("hex");
    if (packagedXpi !== frozenXpi) fail(`包内 XPI 与仓库冻结件不一致：${packagedXpi} != ${frozenXpi}`);
    else process.stdout.write(`  ✔ XPI SHA-256 与仓库冻结件一致：${packagedXpi}\n`);

    // 6. 版本一致性：package.json / plugin.json / marketplace.json 三处同值
    const pkg = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8")) as { version: string; name: string };
    const plugin = JSON.parse(await readFile(join(unpacked, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    const marketplace = JSON.parse(await readFile(resolve(projectRoot, ".claude-plugin", "marketplace.json"), "utf8")) as {
      plugins: Array<{ version: string; source: { package: string; version: string } }>;
    };
    const marketEntry = marketplace.plugins[0]!;
    const versions = { pkg: pkg.version, plugin: plugin.version, marketplaceEntry: marketEntry.version, marketplaceSource: marketEntry.source.version };
    if (new Set(Object.values(versions)).size !== 1) fail(`版本不一致：${JSON.stringify(versions)}`);
    else process.stdout.write(`  ✔ 版本四处一致：${pkg.version}\n`);
    if (marketEntry.source.package !== pkg.name) fail(`marketplace 引用的包名与发布包不一致：${marketEntry.source.package} != ${pkg.name}`);
    else process.stdout.write(`  ✔ marketplace 引用包名一致：${pkg.name}\n`);

    if (failures === 0) process.stdout.write("\n✔ tarball 审计全部通过\n");
    else process.stdout.write(`\n✘ tarball 审计失败：${failures} 项\n`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  if (failures > 0) process.exit(1);
}

await main();
