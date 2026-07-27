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

/** onMailRouteRequest 监听器签名：api.js 转发一条已认证/已过 capability 门禁的邮件 route 请求，background 必须调用 respondMailRoute 或 failMailRoute 之一响应。 */
type MailRouteRequestListener = (token: string, routeId: string, capability: string, bodyJson: string) => void;

interface ThunderbirdSkillBridgeApi {
  start(): Promise<ThunderbirdSkillBridgeState>;
  getState(): Promise<ThunderbirdSkillBridgeState>;
  beginPairing(clientId: string, publicKeyAlgorithm: "Ed25519", publicKeySpkiBase64: string): Promise<ThunderbirdSkillBridgeState>;
  confirmPairing(intentId: string, code: string): Promise<ThunderbirdSkillBridgeState>;
  revokePairing(): Promise<ThunderbirdSkillBridgeState>;
  /** api.js 内 MAIL_ROUTES 静态表的 route id 列表；background 用它自检本地 handler 登记表是否漂移。 */
  listMailRoutes(): Promise<string[]>;
  respondMailRoute(token: string, resultJson: string): Promise<void>;
  failMailRoute(token: string, errorCode: string, errorMessage: string): Promise<void>;
  onMailRouteRequest: {
    addListener(listener: MailRouteRequestListener): void;
    removeListener(listener: MailRouteRequestListener): void;
    hasListener(listener: MailRouteRequestListener): boolean;
  };
}

interface Browser {
  thunderbirdSkillBridge: ThunderbirdSkillBridgeApi;
}

declare const browser: Browser;
