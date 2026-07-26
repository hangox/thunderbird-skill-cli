// 生成可发布的 Claude Code plugin / npm 包 staging 目录。
//
// 设计意图：开发仓库（私有、含 native 存档与测试）与对外发布包严格分离。
// 本脚本只按**白名单**复制，从不整目录递归拷贝，避免任何未预期文件进入 tarball。
//
// 产物布局（即 npm 包根，也是 plugin root）：
//   .claude-plugin/plugin.json     插件清单
//   skills/thunderbird/            Skill（SKILL.md + references）
//   bin/thunderbird.js             可执行入口
//   dist/                          CLI runtime JS
//   assets/thunderbird-skill-bridge.xpi
//   package.json / README.md
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = resolve(projectRoot, "build", "plugin");
const XPI_SOURCE = resolve(projectRoot, "thunderbird-skill-bridge-phase1.xpi");
const XPI_TARGET_NAME = "thunderbird-skill-bridge.xpi";

interface RootPackage {
  version: string;
  description: string;
  engines: Record<string, string>;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full));
    }
  }
  await walk(root);
  return out.sort();
}

const rootPackage = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as RootPackage;
const { version } = rootPackage;

// ---- 0. XPI 安全评审基准门禁（F1）
// 仅比较"根 XPI 与包内副本"是恒真检查，发现不了 XPI 被替换成未经评审的内容。
// 这里改为与受 Git 管理的版本化清单比对：现场生成的 XPI 必须等于评审过的 SHA。
interface ChecksumManifest {
  generatorPlatform: string;
  versions: Record<string, { xpiSha256: string }>;
}
const manifestPath = resolve(projectRoot, "release", "xpi-checksums.json");
let checksums: ChecksumManifest;
try {
  checksums = JSON.parse(await readFile(manifestPath, "utf8")) as ChecksumManifest;
} catch {
  throw new Error(`缺少 XPI 校验清单 ${relative(projectRoot, manifestPath)}；不允许在无评审基准的情况下构建发布包`);
}
const expected = checksums.versions[version];
if (!expected) {
  throw new Error(`XPI 校验清单中没有版本 ${version} 的条目；扩展内容变更后必须显式更新清单并重新安全评审`);
}
// XPI 字节可复现性依赖 macOS /usr/bin/zip，跨平台未验证。
if (process.platform !== checksums.generatorPlatform) {
  throw new Error(`XPI 必须在 ${checksums.generatorPlatform} 上生成（当前 ${process.platform}）；跨平台 zip 字节一致性未经验证，校验失败应视为平台差异并重新安全评审，不得直接改写清单 SHA`);
}

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });

// ---- 1. CLI runtime：只取编译产物的 .js，排除 .map/.d.ts，减小体积也避免泄漏源码路径
const distSource = resolve(projectRoot, "dist");
await mkdir(join(stagingRoot, "dist"), { recursive: true });
await cp(distSource, join(stagingRoot, "dist"), {
  recursive: true,
  filter: (source) => {
    if (source === distSource) return true;
    return !source.endsWith(".map") && !source.endsWith(".d.ts");
  },
});

// ---- 2. Skill：官方约定为 plugin root 下 skills/<name>/SKILL.md
await mkdir(join(stagingRoot, "skills"), { recursive: true });
await cp(resolve(projectRoot, "skill", "thunderbird"), join(stagingRoot, "skills", "thunderbird"), { recursive: true });

// ---- 3. XPI：必须来自本轮确定性打包的冻结件
await mkdir(join(stagingRoot, "assets"), { recursive: true });
const xpiSha = await sha256(XPI_SOURCE);
if (xpiSha !== expected.xpiSha256) {
  throw new Error(`根 XPI SHA-256 与评审基准不一致：\n  实测 ${xpiSha}\n  基准 ${expected.xpiSha256}\n扩展内容若确有变更，需重新安全评审并更新 release/xpi-checksums.json`);
}
await cp(XPI_SOURCE, join(stagingRoot, "assets", XPI_TARGET_NAME));
const stagedXpiSha = await sha256(join(stagingRoot, "assets", XPI_TARGET_NAME));
if (stagedXpiSha !== expected.xpiSha256) throw new Error(`staging 内 XPI SHA 与评审基准不一致：${stagedXpiSha}`);

// ---- 4. bin wrapper：转发到 dist/cli.js，保持单一实现
await mkdir(join(stagingRoot, "bin"), { recursive: true });
await writeFile(join(stagingRoot, "bin", "thunderbird.js"),
  `#!/usr/bin/env node\n// 发布包可执行入口：转发到 CLI 实现，避免重复逻辑。\nimport "../dist/cli.js";\n`, { mode: 0o755 });

// ---- 5. plugin.json：官方 schema 中仅 name 必填；其余为元数据。
// skills/ 位于默认发现位置，因此不声明自定义 skills 路径。
await mkdir(join(stagingRoot, ".claude-plugin"), { recursive: true });
await writeFile(join(stagingRoot, ".claude-plugin", "plugin.json"), `${JSON.stringify({
  name: "thunderbird",
  // 不声明 displayName：该字段需 Claude Code >= 2.1.143，较旧版本的
  // `claude plugin validate` 会直接报 Unrecognized key。省略时官方回退到 name。
  version,
  description: "按需加载的 Thunderbird Skill：通过一次性本地 CLI 访问专用 Thunderbird 扩展，不注册常驻 MCP server。",
  author: { name: "hangox", url: "https://github.com/hangox" },
  homepage: "https://github.com/hangox/thunderbird-skill-cli",
  repository: "https://github.com/hangox/thunderbird-skill-cli",
  license: "Apache-2.0",
  keywords: ["thunderbird", "email", "cli", "skill"],
}, null, 2)}\n`);

// ---- 6. 发布用 package.json：与开发包分离，files 为显式白名单
await writeFile(join(stagingRoot, "package.json"), `${JSON.stringify({
  name: "@hangox/thunderbird-skill-cli",
  version,
  description: rootPackage.description,
  type: "module",
  license: "Apache-2.0",
  bin: { thunderbird: "bin/thunderbird.js" },
  files: [".claude-plugin/", "skills/", "bin/", "dist/", "assets/", "README.md", "LICENSE", "NOTICE"],
  engines: rootPackage.engines,
  repository: { type: "git", url: "git+https://github.com/hangox/thunderbird-skill-cli.git" },
  homepage: "https://github.com/hangox/thunderbird-skill-cli",
  keywords: ["claude-code", "claude-code-plugin", "thunderbird", "email", "cli"],
  // access:public 是 scoped 包首次公开发布所必需。
  // 不写死 provenance：npm 在受支持的 CI 上会自动生成 provenance；而本仓库为私有仓库，
  // 强制 provenance:true 可能导致首次发布直接失败。是否可用留待首次发布时实测确认。
  publishConfig: { access: "public" },
}, null, 2)}\n`);

await cp(resolve(projectRoot, "README.md"), join(stagingRoot, "README.md"));
// Apache-2.0 要求随分发附带 LICENSE 与 NOTICE
await cp(resolve(projectRoot, "LICENSE"), join(stagingRoot, "LICENSE"));
await cp(resolve(projectRoot, "NOTICE"), join(stagingRoot, "NOTICE"));

// ---- 7. 输出清单与校验值
const files = await listFiles(stagingRoot);
let total = 0;
for (const f of files) total += (await stat(join(stagingRoot, f))).size;

process.stdout.write(`plugin staging 目录：${relative(projectRoot, stagingRoot)}\n`);
process.stdout.write(`版本：${version}\n`);
process.stdout.write(`XPI SHA-256：${xpiSha}（== 评审基准）\n`);
process.stdout.write(`文件数：${files.length}，合计 ${(total / 1024).toFixed(1)} KiB\n`);
for (const f of files) process.stdout.write(`  ${f}\n`);
