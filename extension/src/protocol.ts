export const TRANSPORT_PROTOCOL_VERSION = 1 as const;
export const LOOPBACK_ADDRESS = "127.0.0.1" as const;
export const STATUS_ROUTE = "/v1/status" as const;
export const MAX_CLOCK_SKEW_MS = 30_000;
export const DESCRIPTOR_VERSION = 2 as const;
export const CLI_VERSION = "0.2.1" as const;
export const PUBLIC_KEY_ALGORITHM = "Ed25519" as const;
export const PAIRING_EPOCH_PATTERN = /^(0|[1-9][0-9]{0,15})$/;
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// Capability 字面量集合与 src/contracts/routes.ts 的 MailCapability 是同一份契约的
// 两处镜像（extension/ 与 src/ 是两个独立的 tsconfig rootDir，不能跨界 import）。
// 新增/删除能力标识时两处必须同步修改。v0.3.0 范围裁决排除永久删除、watch、
// calendar，因此不含 mail.delete-confirmed.v1 / mail.watch.v1 / calendar.read.v1
// 这类没有对应 route 的死能力标识。
export type Capability =
  | "mail.read.v1"
  | "mail.reversible.v1"
  | "draft.write.v1"
  | "mail.send-confirmed.v1";
export interface InstanceDescriptor {
  descriptorVersion: typeof DESCRIPTOR_VERSION; protocolVersion: typeof TRANSPORT_PROTOCOL_VERSION; instanceId: string; profileId: string;
  profileLabel: string; pid: number; port: number; sessionToken: string; extensionVersion: string; pairingEpoch: string; startedAt: string; expiresAt: string;
}
export interface StatusResponse {
  protocolVersion: typeof TRANSPORT_PROTOCOL_VERSION; minCliVersion: string; maxCliVersion: string; extensionVersion: string;
  instanceId: string; profileId: string; capabilities: Capability[]; pairingState: "unpaired" | "pairing" | "paired" | "revoked"; pairingEpoch: string; authorizedAccountRefs: string[];
}
export interface SecurityRequest {
  localAddress: string; method: string; path: string; host: string; origin?: string; contentType: string; contentLength: string;
  authorization: string; clientName: string; clientVersion: string; protocol: string; requestId: string; timestamp: string; nonce: string; bodySha256: string;
  pairingEpoch: string; clientId?: string; signature?: string;
}
export interface ClientAuthorization { clientId: string; publicKeyAlgorithm: typeof PUBLIC_KEY_ALGORITHM; publicKeySpkiBase64: string; }

export class ProtocolError extends Error {
  constructor(readonly statusCode: 400 | 401 | 403 | 409 | 426, message: string, readonly code = "E_REJECTED") { super(message); }
}

export class NonceCache {
  private readonly seen = new Map<string, number>();
  claim(nonce: string, requestTimestampMs: number, nowMs: number): boolean {
    for (const [value, expiresAt] of this.seen) if (expiresAt < nowMs) this.seen.delete(value);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, requestTimestampMs + MAX_CLOCK_SKEW_MS);
    return true;
  }
}

export function constantTimeTokenEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

export function canonicalizeRequest(request: Pick<SecurityRequest, "method" | "path" | "host" | "protocol" | "requestId" | "timestamp" | "nonce" | "bodySha256" | "pairingEpoch">): string {
  return [request.method.toUpperCase(), request.path, request.host, request.protocol, request.requestId, request.timestamp, request.nonce, request.bodySha256, request.pairingEpoch].join("\n");
}

export function isEd25519Spki(value: string): boolean {
  if (typeof value !== "string" || value.length !== 60 || !/^[A-Za-z0-9+/]{59}=$/.test(value)) return false;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (bytes.length !== 44) return false;
    return Array.from(bytes.subarray(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("") === "302a300506032b6570032100";
  } catch { return false; }
}

async function verifyEd25519(request: SecurityRequest, client: ClientAuthorization): Promise<boolean> {
  if (!request.signature) return false;
  if (client.publicKeyAlgorithm !== PUBLIC_KEY_ALGORITHM || !isEd25519Spki(client.publicKeySpkiBase64)) return false;
  try {
    const keyBytes = Uint8Array.from(atob(client.publicKeySpkiBase64), (character) => character.charCodeAt(0));
    const signature = Uint8Array.from(atob(request.signature), (character) => character.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(canonicalizeRequest(request)));
  } catch { return false; }
}

export async function validateStatusRequest(input: {
  request: SecurityRequest; expectedPort: number; sessionToken: string; pairingState: StatusResponse["pairingState"];
  client?: ClientAuthorization; nonceCache: NonceCache; pairingEpoch: string; nowMs?: number;
}): Promise<void> {
  const { request } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (request.localAddress !== LOOPBACK_ADDRESS) throw new ProtocolError(403, "请求被拒绝");

  const token = request.authorization.startsWith("Bearer ") ? request.authorization.slice(7) : "";
  if (!/^[a-f0-9]{64}$/.test(token) || !constantTimeTokenEqual(token, input.sessionToken)) throw new ProtocolError(401, "认证失败");

  if (request.host !== `${LOOPBACK_ADDRESS}:${input.expectedPort}`) throw new ProtocolError(403, "请求被拒绝");
  if (request.origin !== undefined && request.origin !== "") throw new ProtocolError(403, "请求被拒绝");
  if (request.clientName !== "thunderbird-skill-cli" || request.protocol !== String(TRANSPORT_PROTOCOL_VERSION)) throw new ProtocolError(426, "客户端协议不兼容");
  // canonical 变更不 bump protocolVersion：靠版本握手在验签之前给出精确的 E_VERSION_MISMATCH。
  if (request.clientVersion !== CLI_VERSION) throw new ProtocolError(426, "CLI 与扩展版本不兼容", "E_VERSION_MISMATCH");
  if (!PAIRING_EPOCH_PATTERN.test(request.pairingEpoch)) throw new ProtocolError(401, "请求认证元数据无效");
  if (request.pairingEpoch !== input.pairingEpoch) throw new ProtocolError(409, "配对代已变更", "E_PAIRING_CHANGED");
  if (!/^cli_[0-9a-f-]{36}$/.test(request.requestId) || !/^[a-f0-9]{32}$/.test(request.nonce)) throw new ProtocolError(400, "请求标识格式不合法");
  const timestamp = Number(request.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs - timestamp) > MAX_CLOCK_SKEW_MS) throw new ProtocolError(401, "请求时间无效");
  if (!input.nonceCache.claim(request.nonce, timestamp, nowMs)) throw new ProtocolError(409, "请求已重放");

  if (input.pairingState === "paired") {
    if (!input.client || request.clientId !== input.client.clientId || !(await verifyEd25519(request, input.client))) throw new ProtocolError(401, "client 签名认证失败");
  } else if (request.clientId !== undefined || request.signature !== undefined) {
    throw new ProtocolError(401, "未配对状态不接受 client 身份");
  }

  if (request.method !== "GET" || request.path !== STATUS_ROUTE) throw new ProtocolError(400, "route 不允许");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.contentType.trim())) throw new ProtocolError(400, "Content-Type 不允许");
  if (request.contentLength !== "0" || request.bodySha256 !== EMPTY_BODY_SHA256) throw new ProtocolError(400, "status 请求 body 不允许");
}

// ---------------------------------------------------------------------------
// 全部邮件 route 的通用校验管线。
//
// 与 validateStatusRequest 刻意保持独立实现（而不是让 validateStatusRequest
// 反过来调用这里）：/v1/status 在未配对状态下也必须可用（doctor/status 是
// 唯一允许在 unpaired 时探测的入口），而邮件 route 在未配对状态下必须
// 无条件失败关闭——两者的"是否要求签名"这条分支语义不同，合并成一个函数
// 反而会引入一个需要靠布尔参数才能表达的隐藏分支，不如各自独立、各自可读。
//
// 调用方（extension/bridge/api.js 的镜像实现）必须只依据 route 的静态元数据
// （method/path/capability/maxRequestBodyBytes，来自 src/contracts/routes.ts
// 冻结的表）传入这里，不得信任请求体里任何自称的 risk/capability 字段。
// ---------------------------------------------------------------------------

export interface MailRouteMetadata {
  readonly method: string;
  readonly path: string;
  readonly capability: Capability;
  readonly maxRequestBodyBytes: number;
}

export async function validateMailRouteRequest(input: {
  request: SecurityRequest;
  route: MailRouteMetadata;
  expectedPort: number;
  sessionToken: string;
  pairingState: StatusResponse["pairingState"];
  client?: ClientAuthorization;
  grantedCapabilities: readonly Capability[];
  nonceCache: NonceCache;
  pairingEpoch: string;
  nowMs?: number;
}): Promise<void> {
  const { request, route } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (request.localAddress !== LOOPBACK_ADDRESS) throw new ProtocolError(403, "请求被拒绝");

  const token = request.authorization.startsWith("Bearer ") ? request.authorization.slice(7) : "";
  if (!/^[a-f0-9]{64}$/.test(token) || !constantTimeTokenEqual(token, input.sessionToken)) throw new ProtocolError(401, "认证失败");

  if (request.host !== `${LOOPBACK_ADDRESS}:${input.expectedPort}`) throw new ProtocolError(403, "请求被拒绝");
  if (request.origin !== undefined && request.origin !== "") throw new ProtocolError(403, "请求被拒绝");
  if (request.clientName !== "thunderbird-skill-cli" || request.protocol !== String(TRANSPORT_PROTOCOL_VERSION)) throw new ProtocolError(426, "客户端协议不兼容");
  if (request.clientVersion !== CLI_VERSION) throw new ProtocolError(426, "CLI 与扩展版本不兼容", "E_VERSION_MISMATCH");
  if (!PAIRING_EPOCH_PATTERN.test(request.pairingEpoch)) throw new ProtocolError(401, "请求认证元数据无效");
  if (request.pairingEpoch !== input.pairingEpoch) throw new ProtocolError(409, "配对代已变更", "E_PAIRING_CHANGED");
  if (!/^cli_[0-9a-f-]{36}$/.test(request.requestId) || !/^[a-f0-9]{32}$/.test(request.nonce)) throw new ProtocolError(400, "请求标识格式不合法");
  const timestamp = Number(request.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs - timestamp) > MAX_CLOCK_SKEW_MS) throw new ProtocolError(401, "请求时间无效");
  if (!input.nonceCache.claim(request.nonce, timestamp, nowMs)) throw new ProtocolError(409, "请求已重放");

  // 邮件 route 未配对时无条件失败关闭：不存在"未配对也能探测"的邮件 endpoint。
  if (input.pairingState !== "paired" || !input.client) throw new ProtocolError(401, "未配对，拒绝任何邮件能力调用");
  if (request.clientId !== input.client.clientId || !(await verifyEd25519(request, input.client))) throw new ProtocolError(401, "client 签名认证失败");

  // 风险由 route 的静态元数据决定；capability 由配对时授予的集合决定，两者都不接受请求体自称。
  if (!input.grantedCapabilities.includes(route.capability)) throw new ProtocolError(403, "当前配对未获授予该能力", "E_POLICY_DENIED");

  if (request.method !== route.method || request.path !== route.path) throw new ProtocolError(400, "route 不允许");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.contentType.trim())) throw new ProtocolError(400, "Content-Type 不允许");
  const contentLength = Number(request.contentLength);
  if (!Number.isInteger(contentLength) || contentLength < 0) throw new ProtocolError(400, "Content-Length 不合法");
  if (contentLength > route.maxRequestBodyBytes) throw new ProtocolError(400, "请求 body 超过该 route 的硬上限", "E_VALIDATION");
}
