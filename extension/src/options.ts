const serviceState = document.querySelector<HTMLElement>("#service-state");
const pairingState = document.querySelector<HTMLElement>("#pairing-state");
const clientId = document.querySelector<HTMLElement>("#client-id");
const pairingCode = document.querySelector<HTMLElement>("#pairing-code");
const confirmButton = document.querySelector<HTMLButtonElement>("#confirm-pairing");
const revokeButton = document.querySelector<HTMLButtonElement>("#revoke-pairing");
const capabilitiesForm = document.querySelector<HTMLFormElement>("#capabilities-form");
const applyCapabilitiesButton = document.querySelector<HTMLButtonElement>("#apply-capabilities");
const capabilitiesStatus = document.querySelector<HTMLElement>("#capabilities-status");

type DisplayedIntent = Readonly<{
  intentId: string;
  code: string;
  clientId: string | null;
}>;

let displayedIntent: DisplayedIntent | null = null;

// 与 src/contracts/routes.ts 的 MAIL_CAPABILITIES 是同一份契约的镜像（options
// 页面运行在普通网页上下文，无法跨 extension/src 与 src 两个独立 tsconfig
// rootDir 共享同一份编译产物）；新增/删除能力标识时两处必须同步修改。这里
// 额外给每个能力标识配一句面向最终用户的中文说明。
const CAPABILITY_OPTIONS: ReadonlyArray<Readonly<{ value: string; label: string; description: string }>> = [
  { value: "mail.read.v1", label: "读取邮件", description: "账号、文件夹、搜索、邮件正文与附件元数据等只读能力" },
  { value: "mail.reversible.v1", label: "标记 / 移动 / 撤销 / 保存附件", description: "标记已读或星标、移动邮件、移入废纸篓、撤销上述操作、保存附件到本地目录" },
  { value: "draft.write.v1", label: "创建与编辑草稿", description: "创建、更新草稿，或在 Thunderbird 撰写窗口中打开草稿；不包含外发" },
  { value: "mail.send-confirmed.v1", label: "外发确认", description: "对已创建草稿执行 prepare/confirm 两阶段确认后发送" },
];

function capabilityCheckbox(value: string): HTMLInputElement | null {
  return capabilitiesForm?.querySelector<HTMLInputElement>(`input[type="checkbox"][value="${CSS.escape(value)}"]`) ?? null;
}

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

  const paired = state.pairingState === "paired";
  for (const option of CAPABILITY_OPTIONS) {
    const checkbox = capabilityCheckbox(option.value);
    if (!checkbox) continue;
    checkbox.checked = state.capabilities.includes(option.value);
    checkbox.disabled = !paired;
  }
  if (applyCapabilitiesButton) applyCapabilitiesButton.disabled = !paired;
  if (capabilitiesStatus && !paired) capabilitiesStatus.textContent = "未配对，无法授予能力";
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

// 覆盖式写入：勾选框当前状态即为提交后的最终 capabilities 集合，不是增量
// add/remove。setMailCapabilities 本身在扩展侧拒绝未知能力标识与未配对状态，
// 这里的表单不做重复校验，只负责把 UI 状态原样转成一次调用。
capabilitiesForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = CAPABILITY_OPTIONS.filter((option) => capabilityCheckbox(option.value)?.checked).map((option) => option.value);
  if (capabilitiesStatus) capabilitiesStatus.textContent = "正在保存…";
  if (applyCapabilitiesButton) applyCapabilitiesButton.disabled = true;
  try {
    const state = await browser.thunderbirdSkillBridge.setMailCapabilities(selected);
    render(state);
    if (capabilitiesStatus) {
      capabilitiesStatus.textContent = selected.length > 0 ? `已保存，当前授予 ${selected.length} 项能力` : "已保存，当前未授予任何能力（全部邮件 route 将失败关闭）";
    }
  } catch (error) {
    if (capabilitiesStatus) capabilitiesStatus.textContent = `保存失败：${error instanceof Error ? error.message : "未知错误"}`;
    await refresh();
  }
});

void refresh();
