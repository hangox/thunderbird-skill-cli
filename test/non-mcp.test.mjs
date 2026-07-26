import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { test } from "node:test";

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".js", ".cjs", ".mjs"].includes(extname(entry.name)) ? [path] : [];
  });
}

test("运行时代码不包含 MCP 或 JSON-RPC 兼容入口", () => {
  const roots = [new URL("../src", import.meta.url), new URL("../extension/src", import.meta.url)];
  const source = roots
    .flatMap((root) => sourceFiles(root.pathname))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");

  const forbidden = [
    ["tools", "list"].join("/"),
    ["tools", "call"].join("/"),
    ["json", "rpc"].join(""),
    ["serve", "stdio"].join(" --"),
  ];

  for (const marker of forbidden) {
    assert.equal(source.toLowerCase().includes(marker), false, `发现禁止的兼容入口：${marker}`);
  }
});
