import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";

const KEYCHAIN_SERVICE = "thunderbird-skill-cli";

// 纯断言常量：只声明本 CLI 唯一支持的密钥类型，绝不用于选择签名算法。
export const PUBLIC_KEY_ALGORITHM = "Ed25519" as const;

export interface SigningIdentity {
  clientId: string;
  privateKeyPem: string;
}

export interface PairingIdentity extends SigningIdentity {
  publicKeyAlgorithm: typeof PUBLIC_KEY_ALGORITHM;
  publicKeySpkiBase64: string;
}

export interface CanonicalRequest {
  method: string;
  path: string;
  host: string;
  protocolVersion: number;
  requestId: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
  pairingEpoch: string;
}

export function canonicalizeRequest(request: CanonicalRequest): string {
  return [
    request.method.toUpperCase(), request.path, request.host, String(request.protocolVersion),
    request.requestId, request.timestamp, request.nonce, request.bodySha256, request.pairingEpoch,
  ].join("\n");
}

export function signRequest(request: CanonicalRequest, identity: SigningIdentity): string {
  const key = createPrivateKey(identity.privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Keychain 中的 client key 不是 Ed25519 私钥");
  return sign(null, Buffer.from(canonicalizeRequest(request), "utf8"), key).toString("base64");
}

function validateClientId(clientId: string): boolean {
  return /^client_[A-Za-z0-9_-]{8,128}$/.test(clientId);
}

async function runSecurity(arguments_: string[], input?: string): Promise<{ ok: boolean; stdout: string }> {
  if (process.platform !== "darwin") return { ok: false, stdout: "" };
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/security", arguments_, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let settled = false;
    const finish = (value: { ok: boolean; stdout: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", () => finish({ ok: false, stdout: "" }));
    child.on("close", (code) => finish({ ok: code === 0, stdout: Buffer.concat(stdout).toString("utf8").trim() }));
    const deadline = setTimeout(() => { child.kill(); finish({ ok: false, stdout: "" }); }, 3_000);
    child.stdin.end(input);
  });
}

export async function loadSigningIdentityFromKeychain(clientId: string): Promise<PairingIdentity | undefined> {
  if (!validateClientId(clientId)) return undefined;
  const result = await runSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", clientId, "-w"]);
  if (!result.ok || !/^[A-Za-z0-9+/]+=*$/.test(result.stdout)) return undefined;
  try {
    const key = createPrivateKey({ key: Buffer.from(result.stdout, "base64"), type: "pkcs8", format: "der" });
    if (key.asymmetricKeyType !== "ed25519") return undefined;
    return {
      clientId,
      publicKeyAlgorithm: PUBLIC_KEY_ALGORITHM,
      privateKeyPem: key.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKeySpkiBase64: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"),
    };
  } catch { return undefined; }
}

export async function createSigningIdentityInKeychain(clientId: string): Promise<PairingIdentity | undefined> {
  if (!validateClientId(clientId) || process.platform !== "darwin") return undefined;
  if (await loadSigningIdentityFromKeychain(clientId)) return undefined;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const privateKeyBase64 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
  const stored = await runSecurity(
    ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", clientId, "-w"],
    `${privateKeyBase64}\n${privateKeyBase64}\n`,
  );
  if (!stored.ok && !(await loadSigningIdentityFromKeychain(clientId))) return undefined;
  return {
    clientId,
    publicKeyAlgorithm: PUBLIC_KEY_ALGORITHM,
    privateKeyPem,
    publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

export async function deleteSigningIdentityFromKeychain(clientId: string): Promise<boolean> {
  if (!validateClientId(clientId) || process.platform !== "darwin") return false;
  const result = await runSecurity(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", clientId]);
  return result.ok || !(await loadSigningIdentityFromKeychain(clientId));
}
