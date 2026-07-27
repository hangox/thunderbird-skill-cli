import { request } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PAIRING_EPOCH_PATTERN, type InstanceDescriptor } from "./discovery.js";
import { ERROR_CODES, type ErrorCode } from "./contracts/envelope.js";
import { PUBLIC_KEY_ALGORITHM, signRequest, type PairingIdentity, type SigningIdentity } from "./auth.js";
import { MAIL_CAPABILITIES, type MailRouteSpec } from "./contracts/routes.js";

export const CLI_VERSION = "0.2.1";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CAPABILITIES = new Set<string>(MAIL_CAPABILITIES);

export type Capability = (typeof MAIL_CAPABILITIES)[number];
export interface StatusResponse {
  protocolVersion: number;
  minCliVersion: string;
  maxCliVersion: string;
  extensionVersion: string;
  instanceId: string;
  profileId: string;
  capabilities: Capability[];
  pairingState: "unpaired" | "pairing" | "paired" | "revoked";
  pairingEpoch: string;
  authorizedAccountRefs: string[];
}

export interface PairingIntentResponse {
  intentId: string;
  challengeCode: string;
  clientId: string;
  expiresAt: string;
  pairingState: "pairing";
}

export interface PairingIntentStatusResponse {
  intentId: string;
  pairingState: "pairing" | "paired" | "expired" | "rejected";
  clientId: string;
  expiresAt: string;
}

export class TransportError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

interface ApiResponse {
  statusCode: number;
  contentType: string;
  body: string;
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new TransportError("E_VALIDATION", "服务端版本范围格式不合法");
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(record).length === expected.length && Object.keys(record).every((key) => allowed.has(key));
}

function parseStatus(value: unknown): StatusResponse {
  if (!isRecord(value) || !hasExactKeys(value, ["protocolVersion", "minCliVersion", "maxCliVersion", "extensionVersion", "instanceId", "profileId", "capabilities", "pairingState", "pairingEpoch", "authorizedAccountRefs"])) {
    throw new TransportError("E_VALIDATION", "status 响应包含未知或缺失字段");
  }
  if (!Number.isInteger(value.protocolVersion)) throw new TransportError("E_VALIDATION", "status 协议版本不合法");
  for (const key of ["minCliVersion", "maxCliVersion", "extensionVersion", "instanceId", "profileId"] as const) {
    if (typeof value[key] !== "string") throw new TransportError("E_VALIDATION", `status ${key} 不合法`);
  }
  if (!Array.isArray(value.capabilities) || new Set(value.capabilities).size !== value.capabilities.length || !value.capabilities.every((item) => typeof item === "string" && CAPABILITIES.has(item))) {
    throw new TransportError("E_VALIDATION", "status capabilities 不合法或包含未知/重复能力");
  }
  if (!(["unpaired", "pairing", "paired", "revoked"] as const).includes(value.pairingState as StatusResponse["pairingState"])) {
    throw new TransportError("E_VALIDATION", "status pairingState 不合法");
  }
  if (typeof value.pairingEpoch !== "string" || !PAIRING_EPOCH_PATTERN.test(value.pairingEpoch)) {
    throw new TransportError("E_VALIDATION", "status pairingEpoch 不合法");
  }
  if (!Array.isArray(value.authorizedAccountRefs) || !value.authorizedAccountRefs.every((item) => typeof item === "string" && /^acc_[A-Za-z0-9_-]{8,128}$/.test(item))) {
    throw new TransportError("E_VALIDATION", "status authorizedAccountRefs 不合法");
  }
  return value as unknown as StatusResponse;
}

function parsePairingIntent(value: unknown): PairingIntentResponse {
  if (!isRecord(value) || !hasExactKeys(value, ["intentId", "challengeCode", "clientId", "expiresAt", "pairingState"])) {
    throw new TransportError("E_VALIDATION", "pairing intent 响应不合法");
  }
  if (typeof value.intentId !== "string" || !/^intent_[a-f0-9]{32}$/.test(value.intentId) || typeof value.challengeCode !== "string" || !/^\d{6}$/.test(value.challengeCode) || typeof value.clientId !== "string" || !/^client_[A-Za-z0-9_-]{8,128}$/.test(value.clientId) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() || value.pairingState !== "pairing") {
    throw new TransportError("E_VALIDATION", "pairing intent 字段不合法或已过期");
  }
  return value as unknown as PairingIntentResponse;
}

function parsePairingIntentStatus(value: unknown): PairingIntentStatusResponse {
  if (!isRecord(value) || !hasExactKeys(value, ["intentId", "pairingState", "clientId", "expiresAt"])) throw new TransportError("E_VALIDATION", "pairing status 响应不合法");
  if (typeof value.intentId !== "string" || !/^intent_[a-f0-9]{32}$/.test(value.intentId) || typeof value.clientId !== "string" || !/^client_[A-Za-z0-9_-]{8,128}$/.test(value.clientId) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || !(["pairing", "paired", "expired", "rejected"] as const).includes(value.pairingState as PairingIntentStatusResponse["pairingState"])) {
    throw new TransportError("E_VALIDATION", "pairing status 字段不合法");
  }
  return value as unknown as PairingIntentStatusResponse;
}

function isJsonContentType(value: string): boolean {
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value.trim());
}

async function requestApi(input: {
  descriptor: InstanceDescriptor;
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
  timeoutMs: number;
  identity?: SigningIdentity;
}): Promise<ApiResponse> {
  const { descriptor } = input;
  const host = `127.0.0.1:${descriptor.port}`;
  const requestId = `cli_${randomUUID()}`;
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const body = input.body ? JSON.stringify(input.body) : "";
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const canonical = { method: input.method, path: input.path, host, protocolVersion: descriptor.protocolVersion, requestId, timestamp, nonce, bodySha256, pairingEpoch: descriptor.pairingEpoch };
  const headers: Record<string, string> = {
    Host: host,
    Authorization: `Bearer ${descriptor.sessionToken}`,
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    "X-Thunderbird-Client": "thunderbird-skill-cli",
    "X-Thunderbird-Protocol": String(descriptor.protocolVersion),
    "X-Request-Id": requestId,
    "X-Request-Timestamp": timestamp,
    "X-Request-Nonce": nonce,
    "X-Content-SHA256": bodySha256,
    "X-Thunderbird-Client-Version": CLI_VERSION,
    "X-Thunderbird-Pairing-Epoch": descriptor.pairingEpoch,
  };
  if (input.identity) {
    headers["X-Thunderbird-Client-Id"] = input.identity.clientId;
    headers["X-Request-Signature"] = signRequest(canonical, input.identity);
  }

  return new Promise<ApiResponse>((resolve, reject) => {
    let settled = false;
    const finish = <T>(callback: (value: T) => void, value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      callback(value);
    };
    const req = request({ hostname: "127.0.0.1", port: descriptor.port, path: input.path, method: input.method, headers }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          req.destroy(new TransportError("E_VALIDATION", "响应超过大小限制"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => finish(resolve, {
        statusCode: res.statusCode ?? 0,
        contentType: String(res.headers["content-type"] ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    const deadline = setTimeout(() => req.destroy(new TransportError("E_TIMEOUT", "请求超过总时限", true)), input.timeoutMs);
    req.on("error", (error) => {
      if (error instanceof TransportError) finish(reject, error);
      else finish(reject, new TransportError("E_THUNDERBIRD_OFFLINE", "无法连接 Thunderbird 扩展", true));
    });
    req.end(body);
  });
}

function parseJsonResponse(response: ApiResponse): unknown {
  if (!isJsonContentType(response.contentType)) throw new TransportError("E_VALIDATION", "响应 Content-Type 不合法");
  try { return JSON.parse(response.body) as unknown; } catch { throw new TransportError("E_VALIDATION", "响应不是有效 JSON"); }
}

function parseConflictCode(response: ApiResponse): string {
      const value = parseJsonResponse(response);
      if (!isRecord(value) || !hasExactKeys(value, ["error"]) || !isRecord(value.error) || !hasExactKeys(value.error, ["code", "message"]) || typeof value.error.code !== "string" || typeof value.error.message !== "string") {
        throw new TransportError("E_VALIDATION", "冲突响应格式不合法");
      }
      return value.error.code;
    }
    
    function throwForStatus(response: ApiResponse): void {
      if (response.statusCode === 401 || response.statusCode === 403) throw new TransportError("E_AUTH", "本地会话认证失败");
      if (response.statusCode === 409) {
        const code = parseConflictCode(response);
        if (code === "E_REPLAY") throw new TransportError("E_REPLAY", "Thunderbird 扩展拒绝了重复 nonce 请求");
        if (code === "E_PAIRING_PENDING") throw new TransportError("E_PAIRING_PENDING", "已有待确认配对请求；请先在 Thunderbird 扩展设置页完成或拒绝该请求");
        if (code === "E_ALREADY_PAIRED") throw new TransportError("E_ALREADY_PAIRED", "Thunderbird 已配对；请先在扩展设置页显式撤销现有 client");
        // 可重试仅表示"重新发现 descriptor 后再发一次是安全的"，CLI 绝不自动重试写操作。
        if (code === "E_PAIRING_CHANGED") throw new TransportError("E_PAIRING_CHANGED", "Thunderbird 配对代已变更（通常是刚刚撤销过配对）；请重新运行命令以使用新的 descriptor", true);
        throw new TransportError("E_VALIDATION", "Thunderbird 扩展报告未知请求状态冲突");
      }
      if (response.statusCode === 426) {
        const code = parseConflictCode(response);
        if (code === "E_VERSION_MISMATCH") throw new TransportError("E_VERSION_MISMATCH", "CLI 与 Thunderbird 扩展版本不兼容；请升级到匹配的一对版本");
        throw new TransportError("E_VERSION_MISMATCH", "Thunderbird 扩展报告协议不兼容");
      }
      if (response.statusCode >= 400) throw new TransportError("E_VALIDATION", "Thunderbird 扩展拒绝请求");
    }

export async function fetchStatus(descriptor: InstanceDescriptor, timeoutMs: number, identity?: SigningIdentity): Promise<StatusResponse> {
  const response = await requestApi({ descriptor, method: "GET", path: "/v1/status", timeoutMs, ...(identity ? { identity } : {}) });
  throwForStatus(response);
  if (response.statusCode !== 200) throw new TransportError("E_THUNDERBIRD_OFFLINE", "Thunderbird 扩展未返回健康状态", response.statusCode >= 500);
  const status = parseStatus(parseJsonResponse(response));
  if (status.protocolVersion !== descriptor.protocolVersion) throw new TransportError("E_VERSION_MISMATCH", "CLI 与扩展协议主版本不兼容");
  if (status.instanceId !== descriptor.instanceId || status.profileId !== descriptor.profileId) throw new TransportError("E_AUTH", "status 身份与 descriptor 不一致");
  if (status.pairingEpoch !== descriptor.pairingEpoch) throw new TransportError("E_PAIRING_CHANGED", "status pairingEpoch 与 descriptor 不一致；请重新发现实例后重试", true);
  if (compareVersion(CLI_VERSION, status.minCliVersion) < 0 || compareVersion(CLI_VERSION, status.maxCliVersion) > 0) throw new TransportError("E_VERSION_MISMATCH", "CLI 版本不在扩展支持范围内");
  return status;
}

export async function beginPairing(descriptor: InstanceDescriptor, timeoutMs: number, identity: PairingIdentity): Promise<PairingIntentResponse> {
  const response = await requestApi({
    descriptor,
    method: "POST",
    path: "/v1/pairing/intents",
    body: { clientId: identity.clientId, publicKeyAlgorithm: PUBLIC_KEY_ALGORITHM, publicKeySpkiBase64: identity.publicKeySpkiBase64 },
    timeoutMs,
    identity,
  });
  throwForStatus(response);
  if (response.statusCode !== 201) throw new TransportError("E_NOT_PAIRED", "无法创建配对请求");
  return parsePairingIntent(parseJsonResponse(response));
}

export async function fetchPairingIntent(descriptor: InstanceDescriptor, timeoutMs: number, intentId: string, identity: SigningIdentity): Promise<PairingIntentStatusResponse> {
  if (!/^intent_[a-f0-9]{32}$/.test(intentId)) throw new TransportError("E_VALIDATION", "intentId 格式不合法");
  const response = await requestApi({ descriptor, method: "GET", path: `/v1/pairing/intents/${intentId}`, timeoutMs, identity });
  throwForStatus(response);
  if (response.statusCode !== 200) throw new TransportError("E_NOT_PAIRED", "配对请求不存在或已失效");
  return parsePairingIntentStatus(parseJsonResponse(response));
}

// ---------------------------------------------------------------------------
// 全部邮件 route 的通用低层调用原语，供后续实现只读/可逆/草稿-外发能力的
// CLI 命令模块（src/commands/*）复用，不必各自重新实现签名/错误映射。
//
// 与 fetchStatus/beginPairing/fetchPairingIntent 各自的窄错误映射（throwForStatus/
// parseConflictCode）刻意保持独立：那两者的错误码集合是为 /v1/status 与
// /v1/pairing/intents 这两个固定 endpoint 手工穷举的，而邮件 route 的错误码
// 集合由 extension/bridge/api.js 按 route 动态决定（E_POLICY_DENIED、
// E_NOT_FOUND、E_CONFIRMATION_REQUIRED、E_NOT_IMPLEMENTED 等），因此改用
// "body 里的 code 只要是已知 ErrorCode 就直接采信"的通用策略，而不是逐个
// HTTP 状态码硬编码允许哪些 code。
// ---------------------------------------------------------------------------

const KNOWN_ERROR_CODES = new Set<string>(ERROR_CODES);

function isKnownErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && KNOWN_ERROR_CODES.has(value);
}

function parseMailRouteErrorBody(response: ApiResponse): { code: ErrorCode; message: string } | undefined {
  let value: unknown;
  try { value = parseJsonResponse(response); } catch { return undefined; }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isRecord(value.error)) return undefined;
  const errorRecord = value.error;
  const keys = new Set(Object.keys(errorRecord));
  if (!keys.has("code") || !keys.has("message")) return undefined;
  for (const key of keys) if (key !== "code" && key !== "message" && key !== "details") return undefined;
  if (!isKnownErrorCode(errorRecord.code) || typeof errorRecord.message !== "string") return undefined;
  return { code: errorRecord.code, message: errorRecord.message };
}

/**
 * 调用一条已冻结的邮件 route（method 恒为 POST）。identity 必填：全部邮件
 * route 都强制要求 client 签名，未配对/未授予对应 capability 时扩展会在
 * 认证或 capability 检查阶段失败关闭，CLI 侧不做任何本地降级判断。
 */
export async function callMailRoute(
  descriptor: InstanceDescriptor,
  route: Pick<MailRouteSpec, "method" | "path">,
  body: Record<string, unknown>,
  timeoutMs: number,
  identity: SigningIdentity,
): Promise<unknown> {
  const response = await requestApi({ descriptor, method: route.method, path: route.path, body, timeoutMs, identity });
  if (response.statusCode === 200) return parseJsonResponse(response);
  const parsed = parseMailRouteErrorBody(response);
  if (parsed) throw new TransportError(parsed.code, parsed.message, parsed.code === "E_PAIRING_CHANGED");
  if (response.statusCode === 401 || response.statusCode === 403) throw new TransportError("E_AUTH", "本地会话认证失败");
  if (response.statusCode === 404) throw new TransportError("E_NOT_FOUND", "对象不存在，或不属于当前实例/配对范围");
  if (response.statusCode === 426) throw new TransportError("E_VERSION_MISMATCH", "CLI 与 Thunderbird 扩展版本不兼容；请升级到匹配的一对版本");
  if (response.statusCode === 501) throw new TransportError("E_NOT_IMPLEMENTED", "该邮件能力尚未实现");
  throw new TransportError("E_VALIDATION", "Thunderbird 扩展拒绝请求");
}
