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

interface BridgeState extends ThunderbirdSkillBridgeState {
  mode: "phase-1";
  protocolVersion: 1;
  bindAddress: "127.0.0.1";
  mailAccessEnabled: false;
}

const fallbackState: BridgeState = {
  mode: "phase-1",
  protocolVersion: 1,
  bindAddress: "127.0.0.1",
  serviceStarted: false,
  mailAccessEnabled: false,
  port: null,
  descriptorPath: null,
  instanceId: null,
  profileId: null,
  pairingState: "unpaired",
  pairingEpoch: "0",
  clientId: null,
  pendingIntentId: null,
  pendingCode: null,
  pendingClientId: null,
  pendingExpiresAt: null,
  error: "Experiment API 启动失败",
};

async function startBridge(): Promise<BridgeState> {
  try {
    const state = await browser.thunderbirdSkillBridge.start();
    console.info("Thunderbird Skill Bridge：Phase 1 回环服务已启动");
    return {
      mode: "phase-1",
      protocolVersion: 1,
      bindAddress: "127.0.0.1",
      mailAccessEnabled: false,
      ...state,
    };
  } catch (error) {
    console.error("Thunderbird Skill Bridge：Phase 1 回环服务启动失败", error);
    return { ...fallbackState };
  }
}

void startBridge();
