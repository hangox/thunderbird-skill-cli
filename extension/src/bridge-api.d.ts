interface ThunderbirdSkillBridgeState {
  serviceStarted: boolean;
  port: number | null;
  descriptorPath: string | null;
  instanceId: string | null;
  profileId: string | null;
  pairingState: "unpaired" | "pairing" | "paired" | "revoked";
  pairingEpoch: string;
  clientId: string | null;
  pendingIntentId: string | null;
  pendingCode: string | null;
  pendingClientId: string | null;
  pendingExpiresAt: string | null;
  error: string | null;
}

/** onOperation 监听器签名：api.js 把一条已认证/已过 capability 门禁的邮件 route 请求作为一个 operation 转发，background 必须调用 respondToOperation 或 failOperation 之一响应。 */
type OperationListener = (token: string, routeId: string, capability: string, bodyJson: string) => void;

interface ThunderbirdSkillBridgeApi {
  start(): Promise<ThunderbirdSkillBridgeState>;
  getState(): Promise<ThunderbirdSkillBridgeState>;
  beginPairing(clientId: string, publicKeyAlgorithm: "Ed25519", publicKeySpkiBase64: string): Promise<ThunderbirdSkillBridgeState>;
  confirmPairing(intentId: string, code: string): Promise<ThunderbirdSkillBridgeState>;
  revokePairing(): Promise<ThunderbirdSkillBridgeState>;
  /** api.js 内 MAIL_ROUTES 静态表的 route id 列表；background 用它自检本地 handler 登记表是否漂移。 */
  listMailRoutes(): Promise<string[]>;
  respondToOperation(token: string, resultJson: string): Promise<void>;
  failOperation(token: string, errorCode: string, errorMessage: string): Promise<void>;
  onOperation: {
    addListener(listener: OperationListener): void;
    removeListener(listener: OperationListener): void;
    hasListener(listener: OperationListener): boolean;
  };
  /** 账号/能力授权 UI（Task #30）写入已配对 client capabilities 的入口；E1 只提供入口，不实现调用它的 UI。覆盖式写入，未配对时拒绝。 */
  setMailCapabilities(capabilities: readonly string[]): Promise<ThunderbirdSkillBridgeState>;
}

interface Browser {
  thunderbirdSkillBridge: ThunderbirdSkillBridgeApi;
}

declare const browser: Browser;
