const serviceState = document.querySelector<HTMLElement>("#service-state");
const pairingState = document.querySelector<HTMLElement>("#pairing-state");
const clientId = document.querySelector<HTMLElement>("#client-id");
const pairingCode = document.querySelector<HTMLElement>("#pairing-code");
const confirmButton = document.querySelector<HTMLButtonElement>("#confirm-pairing");
const revokeButton = document.querySelector<HTMLButtonElement>("#revoke-pairing");

type DisplayedIntent = Readonly<{
  intentId: string;
  code: string;
  clientId: string | null;
}>;

let displayedIntent: DisplayedIntent | null = null;

function render(state: ThunderbirdSkillBridgeState): void {
  if (serviceState) serviceState.textContent = state.serviceStarted ? `已启动，端口 ${state.port}` : `未启动${state.error ? `：${state.error}` : ""}`;
  if (pairingState) pairingState.textContent = state.pairingState;
  if (clientId) clientId.textContent = state.clientId ?? "未授权";
  if (pairingCode) pairingCode.textContent = state.pendingCode ?? "无待确认配对";
  displayedIntent = state.pendingIntentId && state.pendingCode
    ? Object.freeze({ intentId: state.pendingIntentId, code: state.pendingCode, clientId: state.pendingClientId })
    : null;
  if (confirmButton) confirmButton.disabled = !displayedIntent;
  if (revokeButton) revokeButton.disabled = state.pairingState !== "paired";
}

async function refresh(): Promise<void> {
  render(await browser.thunderbirdSkillBridge.getState());
}

confirmButton?.addEventListener("click", async () => {
  const shown = displayedIntent;
  if (!shown) return;
  const current = await browser.thunderbirdSkillBridge.getState();
  if (current.pendingIntentId !== shown.intentId || current.pendingCode !== shown.code || current.pendingClientId !== shown.clientId) {
    render(current);
    return;
  }
  render(await browser.thunderbirdSkillBridge.confirmPairing(shown.intentId, shown.code));
});

revokeButton?.addEventListener("click", async () => {
  render(await browser.thunderbirdSkillBridge.revokePairing());
});

void refresh();
