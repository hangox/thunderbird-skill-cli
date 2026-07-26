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

interface ThunderbirdSkillBridgeApi {
  start(): Promise<ThunderbirdSkillBridgeState>;
  getState(): Promise<ThunderbirdSkillBridgeState>;
  beginPairing(clientId: string, publicKeyAlgorithm: "Ed25519", publicKeySpkiBase64: string): Promise<ThunderbirdSkillBridgeState>;
  confirmPairing(intentId: string, code: string): Promise<ThunderbirdSkillBridgeState>;
  revokePairing(): Promise<ThunderbirdSkillBridgeState>;
}

interface Browser {
  thunderbirdSkillBridge: ThunderbirdSkillBridgeApi;
}

declare const browser: Browser;
