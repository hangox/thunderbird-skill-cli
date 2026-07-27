interface ThunderbirdSkillBridgeState {
  serviceStarted: boolean;
  port: number | null;
  descriptorPath: string | null;
  instanceId: string | null;
  profileId: string | null;
  pairingState: "unpaired" | "pairing" | "paired" | "revoked";
  pairingEpoch: string;
  clientId: string | null;
  /** 当前已配对 client 的 capability 集合；未配对时恒为 []。写入方式见 setMailCapabilities。 */
  capabilities: readonly string[];
  pendingIntentId: string | null;
  pendingCode: string | null;
  pendingClientId: string | null;
  pendingExpiresAt: string | null;
  error: string | null;
}

/**
 * onOperation 监听器签名：api.js 把一条已认证/已过 capability 门禁的邮件
 * route 请求作为一个 operation 转发，background 必须调用 respondToOperation
 * 或 failOperation 之一响应。clientId/pairingEpoch 取自 api.js 已验证的
 * securityRequest（不是 background 自己声称的值），供 opaque ref 的
 * client/epoch 绑定使用。
 */
type OperationListener = (token: string, routeId: string, capability: string, bodyJson: string, clientId: string, pairingEpoch: string) => void;

/** onPairingRevoked 监听器签名：配对撤销（等价于 epoch 推进）时触发，无参数；background 收到后必须清空其持有的 opaque ref 绑定表。 */
type PairingRevokedListener = () => void;

interface ThunderbirdSkillBridgeApi {
  start(): Promise<ThunderbirdSkillBridgeState>;
  getState(): Promise<ThunderbirdSkillBridgeState>;
  beginPairing(clientId: string, publicKeyAlgorithm: "Ed25519", publicKeySpkiBase64: string): Promise<ThunderbirdSkillBridgeState>;
  confirmPairing(intentId: string, code: string): Promise<ThunderbirdSkillBridgeState>;
  revokePairing(): Promise<ThunderbirdSkillBridgeState>;
  /** api.js 内 MAIL_ROUTES 静态表的 route id 列表；background 用它自检本地 handler 登记表是否漂移。 */
  listMailRoutes(): Promise<string[]>;
  respondToOperation(token: string, resultJson: string): Promise<void>;
  /** detailsJson（Task #43）：可选的结构化失败详情，JSON 字符串形式（api.js 侧独立 allowlist 校验，非法/未知字段静默丢弃）。 */
  failOperation(token: string, errorCode: string, errorMessage: string, detailsJson?: string): Promise<void>;
  onOperation: {
    addListener(listener: OperationListener): void;
    removeListener(listener: OperationListener): void;
    hasListener(listener: OperationListener): boolean;
  };
  onPairingRevoked: {
    addListener(listener: PairingRevokedListener): void;
    removeListener(listener: PairingRevokedListener): void;
    hasListener(listener: PairingRevokedListener): boolean;
  };
  /** 写入已配对 client 的 capabilities（覆盖式，非增量）；未配对时拒绝。extension/options.html 的账号/能力授权 UI 调用它。 */
  setMailCapabilities(capabilities: readonly string[]): Promise<ThunderbirdSkillBridgeState>;
}

interface Browser {
  thunderbirdSkillBridge: ThunderbirdSkillBridgeApi;
}

declare const browser: Browser;
