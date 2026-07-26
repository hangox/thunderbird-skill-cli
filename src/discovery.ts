import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const DESCRIPTOR_VERSION = 2 as const;
export const TRANSPORT_PROTOCOL_VERSION = 1 as const;
export const MAX_DESCRIPTOR_BYTES = 64 * 1024;
export const PAIRING_EPOCH_PATTERN = /^(0|[1-9][0-9]{0,15})$/;

const DESCRIPTOR_KEYS = new Set([
  "descriptorVersion", "protocolVersion", "instanceId", "profileId", "profileLabel",
  "pid", "port", "sessionToken", "extensionVersion", "pairingEpoch", "startedAt", "expiresAt",
]);

export interface InstanceDescriptor {
  descriptorVersion: typeof DESCRIPTOR_VERSION;
  protocolVersion: typeof TRANSPORT_PROTOCOL_VERSION;
  instanceId: string;
  profileId: string;
  profileLabel: string;
  pid: number;
  port: number;
  sessionToken: string;
  extensionVersion: string;
  pairingEpoch: string;
  startedAt: string;
  expiresAt: string;
}

export interface DiscoveredInstance {
  descriptor: InstanceDescriptor;
  descriptorPath: string;
}

export interface DiscoveryIssue {
  file: string;
  reason: string;
}

export interface DiscoveryResult {
  runtimeRoot: string;
  rootState: "ready" | "missing";
  instances: DiscoveredInstance[];
  rejected: DiscoveryIssue[];
}

export class DiscoveryError extends Error {
  constructor(
    readonly code: "E_VALIDATION" | "E_THUNDERBIRD_OFFLINE" | "E_AMBIGUOUS_INSTANCE",
    message: string,
  ) {
    super(message);
  }
}

export function resolveRuntimeRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.THUNDERBIRD_SKILL_RUNTIME_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new DiscoveryError("E_VALIDATION", "运行目录 override 必须是绝对路径");
    }
    return override;
  }
  return join(tmpdir(), "thunderbird-skill-cli");
}

async function assertSecureDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new DiscoveryError("E_VALIDATION", "运行目录必须是真实目录且不能是符号链接");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new DiscoveryError("E_VALIDATION", "运行目录所有者不是当前用户");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new DiscoveryError("E_VALIDATION", "运行目录权限必须为 0700 或更严格");
  }
}

function assertSecureDescriptorStat(stat: Stats): void {
  if (!stat.isFile()) {
    throw new DiscoveryError("E_VALIDATION", "descriptor 必须是普通文件且不能是符号链接");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new DiscoveryError("E_VALIDATION", "descriptor 所有者不是当前用户");
  }
  if ((Number(stat.mode) & 0o177) !== 0) {
    throw new DiscoveryError("E_VALIDATION", "descriptor 权限必须为 0600 或更严格");
  }
  if (stat.size <= 0 || stat.size > MAX_DESCRIPTOR_BYTES) {
    throw new DiscoveryError("E_VALIDATION", "descriptor 大小不合法");
  }
}

interface SecureDescriptorFile {
  content: string;
  device: bigint;
  inode: bigint;
}

async function readSecureDescriptor(path: string): Promise<SecureDescriptorFile> {
  const noFollow = Number(fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(path, Number(fsConstants.O_RDONLY) | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new DiscoveryError("E_VALIDATION", "descriptor 必须是普通文件且不能是符号链接");
    }
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    assertSecureDescriptorStat(await handle.stat());
    return { content: await handle.readFile("utf8"), device: stat.dev, inode: stat.ino };
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === DESCRIPTOR_KEYS.size && keys.every((key) => DESCRIPTOR_KEYS.has(key));
}

function parseDate(value: unknown, name: string): number {
  if (typeof value !== "string") throw new DiscoveryError("E_VALIDATION", `${name} 必须是字符串`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new DiscoveryError("E_VALIDATION", `${name} 不是有效日期`);
  return timestamp;
}

export function parseDescriptor(value: unknown, nowMs = Date.now()): InstanceDescriptor {
  if (!isRecord(value) || !exactKeys(value)) {
    throw new DiscoveryError("E_VALIDATION", "descriptor 字段不完整或包含未知字段");
  }
  if (value.descriptorVersion !== DESCRIPTOR_VERSION || value.protocolVersion !== TRANSPORT_PROTOCOL_VERSION) {
    throw new DiscoveryError("E_VALIDATION", "descriptor 版本不受支持");
  }
  if (typeof value.instanceId !== "string" || !/^inst_[A-Za-z0-9_-]{8,128}$/.test(value.instanceId)) {
    throw new DiscoveryError("E_VALIDATION", "instanceId 格式不合法");
  }
  if (typeof value.profileId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.profileId)) {
    throw new DiscoveryError("E_VALIDATION", "profileId 格式不合法");
  }
  if (typeof value.profileLabel !== "string" || value.profileLabel.length < 1 || value.profileLabel.length > 128) {
    throw new DiscoveryError("E_VALIDATION", "profileLabel 长度不合法");
  }
  if (!Number.isInteger(value.pid) || (value.pid as number) <= 0) {
    throw new DiscoveryError("E_VALIDATION", "pid 不合法");
  }
  if (!Number.isInteger(value.port) || (value.port as number) < 49152 || (value.port as number) > 65535) {
    throw new DiscoveryError("E_VALIDATION", "port 必须是高位动态端口");
  }
  if (typeof value.sessionToken !== "string" || !/^[a-f0-9]{64}$/.test(value.sessionToken)) {
    throw new DiscoveryError("E_VALIDATION", "sessionToken 格式不合法");
  }
  if (typeof value.extensionVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.extensionVersion)) {
    throw new DiscoveryError("E_VALIDATION", "extensionVersion 格式不合法");
  }
  if (typeof value.pairingEpoch !== "string" || !PAIRING_EPOCH_PATTERN.test(value.pairingEpoch)) {
    throw new DiscoveryError("E_VALIDATION", "pairingEpoch 格式不合法");
  }
  const startedAt = parseDate(value.startedAt, "startedAt");
  const expiresAt = parseDate(value.expiresAt, "expiresAt");
  if (startedAt >= expiresAt || expiresAt <= nowMs) {
    throw new DiscoveryError("E_THUNDERBIRD_OFFLINE", "descriptor 已过期");
  }
  return value as unknown as InstanceDescriptor;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function discoverInstances(
  environment: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): Promise<DiscoveryResult> {
  const runtimeRoot = resolveRuntimeRoot(environment);
  try {
    await assertSecureDirectory(runtimeRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { runtimeRoot, rootState: "missing", instances: [], rejected: [] };
    }
    throw error;
  }

  const instancesDirectory = join(runtimeRoot, "instances");
  try {
    await assertSecureDirectory(instancesDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { runtimeRoot, rootState: "missing", instances: [], rejected: [] };
    }
    throw error;
  }

  const instances: DiscoveredInstance[] = [];
  const rejected: DiscoveryIssue[] = [];
  for (const name of (await readdir(instancesDirectory)).sort()) {
    if (!/^inst_[A-Za-z0-9_-]{8,128}\.json$/.test(name)) continue;
    const descriptorPath = join(instancesDirectory, name);
    try {
      const file = await readSecureDescriptor(descriptorPath);
      const parsed = JSON.parse(file.content) as unknown;
      let descriptor: InstanceDescriptor;
      try {
        descriptor = parseDescriptor(parsed, nowMs);
      } catch (error) {
        if (error instanceof DiscoveryError && error.code === "E_THUNDERBIRD_OFFLINE") {
          Object.assign(error, { device: file.device, inode: file.inode });
        }
        throw error;
      }
      if (`${descriptor.instanceId}.json` !== name) {
        throw new DiscoveryError("E_VALIDATION", "descriptor 文件名与 instanceId 不一致");
      }
      if (!isProcessAlive(descriptor.pid)) {
        const staleError = new DiscoveryError("E_THUNDERBIRD_OFFLINE", "descriptor 对应进程不存在");
        Object.assign(staleError, { device: file.device, inode: file.inode });
        throw staleError;
      }
      instances.push({ descriptor, descriptorPath });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "descriptor 无法读取";
      rejected.push({ file: name, reason });
      if (error instanceof DiscoveryError && error.code === "E_THUNDERBIRD_OFFLINE") {
        try {
          const current = await lstat(descriptorPath, { bigint: true });
          const expected = error as DiscoveryError & { device?: bigint; inode?: bigint };
          if (expected.device !== undefined && expected.inode !== undefined && current.dev === expected.device && current.ino === expected.inode) {
            await unlink(descriptorPath);
          }
        } catch { /* 删除失败或文件已替换时保持 rejected，绝不删除替换后的文件 */ }
      }
    }
  }
  return { runtimeRoot, rootState: "ready", instances, rejected };
}
