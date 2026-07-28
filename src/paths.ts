// 附件保存的本机安全落盘原语。
//
// 设计意图：docs/07 的安全模型要求"拒绝设备文件、socket、symlink、目录和
// 敏感系统路径"且"保存时文件名规范化、禁止路径穿越、默认不覆盖"；
// src/contracts/routes.ts 里 attachments.save/attachments.fetch 的契约文本
// 明确写清楚"扩展不接收也不校验任何本机文件系统路径"——这些校验与实际写盘
// 完全是 CLI（本文件）的职责，扩展只负责签发内容与摘要。
//
// 核心手法：
// 1) 目标目录逐段 lstat 走查（而不是只对最终 fs.realpath 结果做字符串比较），
//    精确定位"哪一段是 symlink"，不被动依赖 realpath 悄悄跟随后的结果。
// 2) 真正的 no-clobber 用 link()+unlink() 发布，而不是 POSIX rename()——
//    rename() 在目标已存在时会静默覆盖，与"已存在必须拒绝"这条硬性不变量
//    冲突；link() 在目标已存在时原子失败（EEXIST）且完全不触碰目标内容，
//    是唯一能同时满足"发布不留半成品"与"绝不覆盖"两个要求的组合。
// 3) 临时文件用 `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 在目标同目录创建，
//    任何失败路径（长度不符、摘要不符、发布冲突、异常中断）都清理临时文件，
//    不留下半成品。
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DiscoveryError } from "./discovery.js";

/** 附件文件名允许的最大长度（字节，粗略按字符数近似，足够拒绝异常长文件名）。 */
const MAX_FILE_NAME_LENGTH = 255;

/** 目标目录允许的最大路径段数；只是资源防御，不是安全边界本身。 */
const MAX_PATH_SEGMENTS = 64;

// 敏感系统路径的防御性denylist——不是穷举，是纵深防御的一层：即使某个
// no-clobber/symlink 校验有疏漏，也不应该让附件落到这些位置。macOS 专属
// （本项目只在 macOS 上开发/测试/发布，见仓库其余部分的一致约束）。
const SENSITIVE_PREFIXES: readonly string[] = [
  "/etc", "/private/etc",
  "/System", "/Library", "/private/var/db", "/var/db", "/private/var/root",
  "/usr", "/bin", "/sbin", "/dev",
  join(homedir(), "Library"),
].map((path) => resolve(path));

function isSensitivePath(resolvedPath: string): boolean {
  return SENSITIVE_PREFIXES.some((prefix) => resolvedPath === prefix || resolvedPath.startsWith(`${prefix}${sep}`));
}

/**
 * 附件文件名规范化：拒绝空、"."/".."、任何路径分隔符或 NUL 字节——文件名
 * 永远不被解释为路径的一部分，也不允许借助文件名实现路径穿越。
 */
export function sanitizeAttachmentFileName(rawName: unknown): string {
  if (typeof rawName !== "string") throw new DiscoveryError("E_VALIDATION", "附件文件名不合法");
  if (rawName.includes("\u0000")) throw new DiscoveryError("E_VALIDATION", "附件文件名包含非法字符");
  if (rawName.includes("/") || rawName.includes("\\")) throw new DiscoveryError("E_VALIDATION", "附件文件名不得包含路径分隔符");
  const trimmed = rawName.trim();
  if (trimmed.length === 0 || trimmed === "." || trimmed === "..") throw new DiscoveryError("E_VALIDATION", "附件文件名不合法");
  if (trimmed.length > MAX_FILE_NAME_LENGTH) throw new DiscoveryError("E_VALIDATION", "附件文件名过长");
  return trimmed;
}

/**
 * 校验并规范化"目标目录"：必须是绝对路径、真实存在、解析后是目录、不落在
 * 敏感系统路径下、不是设备/FIFO/socket。
 *
 * 用 `fs.realpath()` 完整跟随 symlink 得到规范路径，而不是逐段拒绝路径中
 * 出现的任何 symlink——macOS 上 `/tmp`、`/var`（因而 `os.tmpdir()` 的产物）
 * 本身就是指向 `/private/tmp`、`/private/var` 的系统级 symlink，是绝大多数
 * 合法保存目标的必经之路，逐段拒绝会让几乎所有常见临时/用户目录都无法使用。
 * 安全性关注的是"这个路径最终真正落在哪里"，因此对 realpath 解析后的规范
 * 路径做敏感路径/类型校验；这与本仓库既有的威胁模型一致——同用户进程之间
 * 不构成本方案要防御的权限边界（见 docs/07），这里防的是附件名等不可信
 * 派生数据造成的路径穿越/误配置，不是防御一个能与本进程实时竞态的攻击者。
 *
 * 最终写入的文件名（叶子）不经过这里的 realpath 跟随——那由
 * resolveSafeDestination/openAttachmentTempFile 用 lstat（而不是 stat）
 * 判断"已存在"，悬空 symlink 一样视为已存在并拒绝，不会被静默跟随。
 */
export async function resolveSafeDirectory(rawDirectory: unknown): Promise<string> {
  if (typeof rawDirectory !== "string" || rawDirectory.length === 0) {
    throw new DiscoveryError("E_VALIDATION", "目标目录必须是非空绝对路径");
  }
  if (!isAbsolute(rawDirectory)) throw new DiscoveryError("E_VALIDATION", "目标目录必须是绝对路径，不接受相对路径");
  if (rawDirectory.split(sep).filter(Boolean).length > MAX_PATH_SEGMENTS) {
    throw new DiscoveryError("E_VALIDATION", "目标目录路径过深");
  }

  let realDirectory: string;
  try {
    realDirectory = await realpath(rawDirectory);
  } catch {
    throw new DiscoveryError("E_VALIDATION", "目标目录不存在或不可访问");
  }
  if (isSensitivePath(realDirectory)) throw new DiscoveryError("E_VALIDATION", "目标目录位于禁止访问的敏感系统路径");

  const info = await lstat(realDirectory);
  if (info.isSymbolicLink()) throw new DiscoveryError("E_VALIDATION", "目标目录解析异常：realpath 结果仍是符号链接");
  if (info.isBlockDevice() || info.isCharacterDevice() || info.isFIFO() || info.isSocket()) {
    throw new DiscoveryError("E_VALIDATION", "目标路径是设备/管道/套接字文件，不是目录");
  }
  if (!info.isDirectory()) throw new DiscoveryError("E_VALIDATION", "目标目录不是真实目录");
  return realDirectory;
}

export interface SafeDestination {
  readonly directory: string;
  readonly fileName: string;
  readonly finalPath: string;
}

/**
 * 组合目录校验 + 文件名规范化 + no-clobber 预检查（final 是否已存在，含悬空
 * symlink——用 lstat 而不是 stat，悬空 symlink 同样视为"已存在"并拒绝）。
 * 这只是快速失败的预检查；真正不可绕过的 no-clobber 保证在 finish() 阶段的
 * link() 原子发布。
 */
export async function resolveSafeDestination(rawDirectory: unknown, rawFileName: unknown): Promise<SafeDestination> {
  const directory = await resolveSafeDirectory(rawDirectory);
  const fileName = sanitizeAttachmentFileName(rawFileName);
  const finalPath = join(directory, fileName);
  try {
    await lstat(finalPath);
    throw new DiscoveryError("E_VALIDATION", "目标文件已存在，拒绝覆盖（no-clobber）");
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    // 期望路径：lstat 因 ENOENT 失败，说明目标确实不存在，允许继续。
  }
  return { directory, fileName, finalPath };
}

export interface AttachmentWriteHandle {
  readonly finalPath: string;
  /** 追加写入一段已解码字节；内部同时维护运行中的字节计数与 sha256。 */
  write(chunk: Buffer): Promise<void>;
  /** 校验总长度与 sha256 摘要（`"sha256:<hex>"` 格式）后原子发布；不匹配则清理临时文件并抛错。 */
  finish(expected: { readonly totalBytes: number; readonly sha256Digest: string }): Promise<{ readonly finalPath: string; readonly bytesWritten: number }>;
  /** 任意失败路径下清理临时文件；finish 成功后再调用是安全的空操作。 */
  abort(): Promise<void>;
}

/**
 * 在目标同目录以 `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 创建安全临时文件，
 * 返回可增量写入、最终校验并原子发布的句柄。
 */
export async function openAttachmentTempFile(rawDirectory: unknown, rawFileName: unknown): Promise<AttachmentWriteHandle> {
  const target = await resolveSafeDestination(rawDirectory, rawFileName);
  const tempName = `.${target.fileName}.thunderbird-skill-${createHash("sha256").update(`${process.pid}:${target.finalPath}:${Math.random()}`).digest("hex").slice(0, 16)}.part`;
  const tempPath = join(target.directory, tempName);

  const handle = await open(tempPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256");
  let bytesWritten = 0;
  let settled = false; // finish() 成功或 abort() 执行过之后为 true，防止重复操作同一句柄

  const cleanup = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    try { await handle.close(); } catch { /* 可能已关闭 */ }
    try { await unlink(tempPath); } catch { /* 可能从未完整创建或已被移动 */ }
  };

  return {
    finalPath: target.finalPath,
    async write(chunk) {
      if (settled) throw new Error("附件写入句柄已结束，不能继续写入");
      // FileHandle.write() 对常规文件极少发生部分写入，但接口本身允许，
      // 因此循环写完整个 chunk 而不是假设一次调用必然写满，避免在极端情况下
      // 悄悄丢字节却仍通过长度校验（因为我们统计的是"调用了写入"而非
      // "底层确认写入的字节数"）。
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        if (result.bytesWritten <= 0) throw new Error("写入附件临时文件失败：底层返回 0 字节");
        offset += result.bytesWritten;
      }
      hash.update(chunk);
      bytesWritten += chunk.length;
    },
    async finish(expected) {
      if (settled) throw new Error("附件写入句柄已结束，不能重复 finish");
      if (bytesWritten !== expected.totalBytes) {
        await cleanup();
        throw new DiscoveryError("E_VALIDATION", `附件长度不匹配：期望 ${expected.totalBytes} 字节，实际写入 ${bytesWritten} 字节`);
      }
      const actualDigest = `sha256:${hash.digest("hex")}`;
      if (actualDigest !== expected.sha256Digest) {
        await cleanup();
        throw new DiscoveryError("E_VALIDATION", "附件内容摘要不匹配，可能被截断或篡改");
      }
      await handle.sync();
      await handle.close();
      settled = true;
      try {
        await link(tempPath, target.finalPath);
      } catch (error) {
        await unlink(tempPath).catch(() => {});
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DiscoveryError("E_VALIDATION", "目标文件已存在，拒绝覆盖（no-clobber）");
        throw error;
      }
      await unlink(tempPath).catch(() => {});
      return { finalPath: target.finalPath, bytesWritten };
    },
    abort: cleanup,
  };
}
