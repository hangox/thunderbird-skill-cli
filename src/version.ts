import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 产品版本的唯一真值来源是 package.json —— 运行时直接读取，不生成、不复制、
// 不硬编码，因此不存在第二个可能漂移的版本源。
//
// 路径在两种形态下都成立：
//   开发仓库：  dist/version.js        -> ../package.json = 仓库根 package.json
//   发布包：    dist/version.js        -> ../package.json = 包根 package.json
//
// 注意：这与 CLI_SCHEMA_VERSION 是**两个不同的概念**。前者是产品版本（0.2.0），
// 后者是 stdout JSON envelope 的契约版本（1.0），二者独立演进，不得混用。

let cached: string | undefined;

export function productVersion(): string {
  if (cached !== undefined) return cached;
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || typeof parsed.version !== "string") {
    throw new Error("package.json 缺少合法的 version 字段");
  }
  cached = parsed.version;
  return cached;
}
