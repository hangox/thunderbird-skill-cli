import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 安装辅助：只负责"告诉用户 XPI 在哪"与"在 Finder 里定位它"。
// 明确不做的事：不自动安装 XPI、不调用 Thunderbird、不绕过任何用户确认。
// 安装动作必须由用户在 Thunderbird 内显式完成。

export const XPI_FILE_NAME = "thunderbird-skill-bridge.xpi";

/**
 * 候选路径按发布形态从最贴近到最兜底排列：
 *  1. 发布包 / plugin cache：<pkgRoot>/assets/<xpi>       （dist/xpi.js -> ../assets）
 *  2. 同上，兼容 dist 再嵌一层的布局                        （dist/**\/xpi.js -> ../../assets）
 *  3. 开发仓库：<repoRoot>/thunderbird-skill-bridge-phase1.xpi
 * 全部基于 import.meta.url 解析，不依赖 cwd，也不引用包外路径。
 */
export function xpiCandidatePaths(moduleUrl: string = import.meta.url): string[] {
  const here = dirname(fileURLToPath(moduleUrl));
  return [
    resolve(here, "..", "assets", XPI_FILE_NAME),
    resolve(here, "..", "..", "assets", XPI_FILE_NAME),
    resolve(here, "..", "thunderbird-skill-bridge-phase1.xpi"),
  ];
}

export interface XpiLocation {
  path: string;
  bytes: number;
}

export async function locateXpi(moduleUrl: string = import.meta.url): Promise<XpiLocation | undefined> {
  for (const candidate of xpiCandidatePaths(moduleUrl)) {
    try {
      await access(candidate, fsConstants.R_OK);
      const info = await stat(candidate);
      if (info.isFile() && info.size > 0) return { path: candidate, bytes: info.size };
    } catch { /* 继续尝试下一个候选路径 */ }
  }
  return undefined;
}

/** 在 Finder 中选中该文件。仅 macOS；失败不抛出，由调用方决定如何呈现。 */
export async function revealInFinder(path: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return new Promise((resolvePromise) => {
    const child = spawn("/usr/bin/open", ["-R", path], { stdio: "ignore" });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolvePromise(value);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    const deadline = setTimeout(() => { child.kill(); finish(false); }, 5_000);
  });
}
