// 确定性单文件 bundler：把 extension/src/background.ts 与它依赖的 ESM 领域
// 模块（refs.ts、schema.ts、extension/src/mail/*.ts）的 tsc 编译产物拼接成
// 一个零 import/export 的 classic script，覆盖写回 extension/dist/background.js。
//
// 设计意图（team-lead 2026-07-27 裁决）：manifest.json 保持 classic
// `background.scripts:[dist/background.js]`，不切换 `type:"module"`（未经
// 真机验证，不冒险）。但多位贡献者各自的邮件能力域文件（accounts/folders/
// search/sanitize/messages/attachments/state/index）都是用真实 ESM
// import/export 编写的普通 TypeScript 模块——把它们手工重写成互相不
// import 的 classic script 既不现实也极易出错。这个脚本用纯文本拼接
// （不引入任何第三方 bundler 依赖，没有第三方代码被注入产物，因此不涉及
// NOTICE/许可证变更）在构建期把它们合并成一个文件，运行时行为等价于
// 真正的 ES 模块图，但产物本身零 import/export。
//
// 确定性保证：
// - MODULES 是显式硬编码的拓扑序列表，不做目录扫描/glob——新增文件必须显式
//   加入这个列表，这本身就是一处"防止遗漏"的检查点。
// - 不生成也不引用任何 sourcemap（拼接前会剥离每个模块自带的
//   `//# sourceMappingURL=...` 注释，那些指向拼接前的单文件 map，在合并后的
//   产物里已经失真）。
// - 不做任何时间戳/环境变量/随机数注入；相同输入产生逐字节相同输出（见
//   test/bundle.test.mjs 的双构建 SHA 对比）。
// - 每个模块被包成一个 IIFE，仅通过显式的值解构（`const { A, B } = __bundle_x;`）
//   访问其他模块的导出——不存在任何"副作用 import"，也不存在会被
//   tree-shaking 摇掉的隐式依赖：这里根本没有 tree-shaking 这一步，每个
//   模块的完整编译产物都会原样进入最终 bundle。

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(projectRoot, "extension/dist");

/**
 * 显式、确定性的依赖拓扑序（被依赖者在前）。新增邮件能力域文件时必须显式
 * 加到这里；这不是自动发现，是刻意的显式登记表。
 */
const MODULES: ReadonlyArray<{ readonly id: string; readonly relPath: string }> = [
  { id: "refs", relPath: "refs.js" },
  { id: "schema", relPath: "schema.js" },
  { id: "mail_state", relPath: "mail/state.js" },
  { id: "mail_sanitize", relPath: "mail/sanitize.js" },
  { id: "mail_accounts", relPath: "mail/accounts.js" },
  { id: "mail_folders", relPath: "mail/folders.js" },
  { id: "mail_attachments", relPath: "mail/attachments.js" },
  { id: "mail_search", relPath: "mail/search.js" },
  { id: "mail_messages", relPath: "mail/messages.js" },
  { id: "mail_index", relPath: "mail/index.js" },
] as const;

const ENTRY = { id: "background", relPath: "background.js" } as const;

const IMPORT_LINE = /^import\s*\{([^}]*)\}\s*from\s*"([^"]+)";\s*$/;
const EXPORT_PREFIX = /^export\s+(async function\*?|function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/;
const SOURCEMAP_COMMENT_LINE = /^\/\/# sourceMappingURL=/;

interface ParsedModule {
  readonly imports: ReadonlyArray<{ readonly names: readonly string[]; readonly fromRelPath: string }>;
  readonly exportedNames: readonly string[];
  readonly body: string;
}

/** 把 "./x.js" / "../y.js" 相对 fromRelPath 所在目录解析成相对 extension/dist 根的 posix 路径。 */
function resolveImportPath(fromRelPath: string, importSpecifier: string): string {
  const fromDir = dirname(fromRelPath);
  const parts = (fromDir === "." ? [] : fromDir.split("/")).concat(importSpecifier.split("/"));
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function parseModule(source: string, relPath: string): ParsedModule {
  const lines = source.split("\n");
  const imports: Array<{ names: string[]; fromRelPath: string }> = [];
  const exportedNames: string[] = [];
  const bodyLines: string[] = [];

  for (const line of lines) {
    const importMatch = IMPORT_LINE.exec(line);
    if (importMatch) {
      const names = (importMatch[1] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const asMatch = /^(\S+)\s+as\s+(\S+)$/.exec(entry);
          return asMatch ? `${asMatch[1]}: ${asMatch[2]}` : entry;
        });
      imports.push({ names, fromRelPath: resolveImportPath(relPath, importMatch[2] ?? "") });
      continue;
    }
    if (SOURCEMAP_COMMENT_LINE.test(line.trim())) continue;

    const exportMatch = EXPORT_PREFIX.exec(line);
    if (exportMatch) {
      exportedNames.push(exportMatch[2] ?? "");
      bodyLines.push(line.replace(/^export\s+/, ""));
      continue;
    }
    bodyLines.push(line);
  }

  const body = bodyLines.join("\n");
  // 安全网：任何逃过上面两条规则的 import/export 行都必须让构建直接失败，
  // 而不是生成一个看起来正常、实际语义已损坏的 bundle。
  for (const line of body.split("\n")) {
    if (/^\s*import\b/.test(line)) throw new Error(`${relPath}: 存在未能解析的 import 行，拒绝生成 bundle：${line}`);
    if (/^\s*export\b/.test(line)) throw new Error(`${relPath}: 存在未能解析的 export 行，拒绝生成 bundle：${line}`);
  }
  return { imports, exportedNames, body };
}

function moduleVarName(id: string): string {
  return `__bundle_${id}`;
}

function renderPreamble(imports: ParsedModule["imports"], relPathToId: ReadonlyMap<string, string>, selfRelPath: string): string {
  return imports
    .map(({ names, fromRelPath }) => {
      const importedId = relPathToId.get(fromRelPath);
      if (!importedId) {
        throw new Error(`${selfRelPath}: import "${fromRelPath}" 不在 scripts/bundle-background.ts 的显式 MODULES 列表中，拒绝生成 bundle`);
      }
      return `  const { ${names.join(", ")} } = ${moduleVarName(importedId)};`;
    })
    .join("\n");
}

// buildBundle() 的读入口（ENTRY.relPath = "background.js"）与 main() 的写出口
// 是同一个路径——这是刻意的（manifest.json 只声明一个 classic script 文件，
// 没有必要再引入一个中间产物名字）。但这意味着 buildBundle() 必须能识别"这个
// 文件已经是上一次 bundle 的产物"并拒绝再次拼接，否则会把已拼接产物当成
// entry 源码再拼一遍，产生重复的顶层声明（`Identifier '__bundle_x' has
// already been declared`）——这不是假设性风险，是本文件开发过程中真实触发过
// 的一次 bug，构建脚本的正常用法（`tsc` 后紧跟 bundler）不会踩到它，但任何
// 脱离这个顺序单独重复调用 buildBundle() 的场景（例如测试反复调用）都会。
const BUNDLE_BANNER_MARKER = "本文件由 scripts/bundle-background.ts";

function assertPristineEntry(source: string): void {
  if (source.includes(BUNDLE_BANNER_MARKER)) {
    throw new Error(
      `${ENTRY.relPath} 看起来已经是上一次 bundle 的产物（包含 bundler banner），而不是 tsc 的原始编译输出。` +
        "请先重新运行 `tsc -p extension/tsconfig.json` 生成 pristine 的 background.js，再调用 buildBundle()，" +
        "避免把已拼接产物当成源码再次拼接（会产生重复的顶层声明）。",
    );
  }
}

/**
 * @param options.distRoot 编译产物根目录，默认 extension/dist（生产用途）。
 *   测试需要反复调用且不能触碰共享的 extension/dist/background.js（那是
 *   `npm run build` 之后其它测试文件依赖的最终产物，被并发跑的测试文件读到
 *   "半途被覆盖"的中间状态会导致不相关的测试假失败）——这个参数让测试可以
 *   指向一份从 tsc 独立、隔离编译出来的临时目录副本。
 */
export async function buildBundle(options?: { readonly distRoot?: string }): Promise<string> {
  const root = options?.distRoot ?? distRoot;
  const relPathToId = new Map(MODULES.map((mod) => [mod.relPath, mod.id] as const));

  const chunks: string[] = [];
  for (const mod of MODULES) {
    const source = await readFile(resolve(root, mod.relPath), "utf8");
    const parsed = parseModule(source, mod.relPath);
    const preamble = renderPreamble(parsed.imports, relPathToId, mod.relPath);
    const exportsObject = parsed.exportedNames.length > 0 ? `\n  return { ${parsed.exportedNames.join(", ")} };\n` : "\n";
    chunks.push(`const ${moduleVarName(mod.id)} = (function () {\n${preamble ? `${preamble}\n` : ""}${parsed.body}${exportsObject}})();`);
  }

  const entrySource = await readFile(resolve(root, ENTRY.relPath), "utf8");
  assertPristineEntry(entrySource);
  const entryParsed = parseModule(entrySource, ENTRY.relPath);
  const entryPreamble = renderPreamble(entryParsed.imports, relPathToId, ENTRY.relPath);

  const banner = [
    `// ${BUNDLE_BANNER_MARKER} 从 extension/src/background.ts 与它依赖的`,
    "// refs.ts/schema.ts/mail/*.ts 编译产物确定性拼接生成，请勿手工编辑。",
    "// 修改任一源文件后重新运行 `npm run build:extension` 会自动重新生成本文件。",
    '"use strict";',
  ].join("\n");

  return [banner, ...chunks, entryPreamble, entryParsed.body].filter((part) => part.length > 0).join("\n\n") + "\n";
}

async function main(): Promise<void> {
  const bundle = await buildBundle();
  await writeFile(resolve(distRoot, ENTRY.relPath), bundle, "utf8");
}

// 只在直接执行本脚本（`node scripts/bundle-background.ts`）时才写文件；被
// test/bundle.test.mjs 之类的调用方 `import()` 时只复用 buildBundle()，
// 不产生任何写盘副作用，方便测试反复调用做可复现性比对。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
