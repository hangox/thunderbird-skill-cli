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

// Task #44（0.4.0）：真实外发额外受一层独立于 capability 系统的浏览器原生
// 可选权限门禁——manifest.json 把 `compose.send` 声明在 `optional_permissions`
// 而不是常驻 `permissions` 里，默认不持有，物理上无法调用
// `compose.sendMessage()`（见 extension/src/mail-api.d.ts 顶部说明与
// extension/src/mail/send.ts 的运行时 `permissions.contains()` 复核）。
// 这里勾选/保存外发确认能力时，必须先经过浏览器原生 `permissions.request()`
// 弹窗让用户真正同意，而不能只是把字符串写进我们自己的 capabilities 数组——
// 那样只是应用层状态，不构成任何物理保证。
const COMPOSE_SEND_PERMISSION = "compose.send";
const SEND_CAPABILITY = "mail.send-confirmed.v1";

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
  const state = await browser.thunderbirdSkillBridge.revokePairing();
  // 撤销配对已经在扩展侧清空了全部 capabilities（含 mail.send-confirmed.v1）；
  // 这里同步收回浏览器层的 compose.send 可选权限，避免留下"capability 已清空
  // 但浏览器权限还挂着"的悬空授权。remove() 对本来就没有的权限是无害的
  // no-op，不需要先 contains() 判断。
  await browser.permissions.remove({ permissions: [COMPOSE_SEND_PERMISSION] });
  render(state);
});

// 覆盖式写入：勾选框当前状态即为提交后的最终 capabilities 集合，不是增量
// add/remove。setMailCapabilities 本身在扩展侧拒绝未知能力标识与未配对状态，
// 这里的表单不做重复校验，只负责把 UI 状态原样转成一次调用。
//
// Task #44：`mail.send-confirmed.v1` 这一项额外绑定浏览器原生 `compose.send`
// 可选权限——表单提交事件本身就是一次用户手势，满足 `permissions.request()`
// 的触发要求：
// - 勾选了它：先 `permissions.request()` 弹出浏览器原生同意框；用户拒绝时
//   （或者浏览器返回 false）绝不能把这一项写进 capabilities，即使复选框
//   当时是勾选状态——UI 状态与实际持有的能力必须保持一致，不能"看起来开了
//   但物理上没有权限"。
// - 没勾选它：`permissions.remove()`，把之前可能持有的可选权限一并收回，
//   不留下能力已关闭、权限还挂着的悬空状态。
capabilitiesForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  let selected = CAPABILITY_OPTIONS.filter((option) => capabilityCheckbox(option.value)?.checked).map((option) => option.value);
  if (capabilitiesStatus) capabilitiesStatus.textContent = "正在保存…";
  if (applyCapabilitiesButton) applyCapabilitiesButton.disabled = true;
  let permissionDenied = false;
  try {
    if (selected.includes(SEND_CAPABILITY)) {
      const granted = await browser.permissions.request({ permissions: [COMPOSE_SEND_PERMISSION] });
      if (!granted) {
        permissionDenied = true;
        selected = selected.filter((value) => value !== SEND_CAPABILITY);
      }
    } else {
      await browser.permissions.remove({ permissions: [COMPOSE_SEND_PERMISSION] });
    }
    const state = await browser.thunderbirdSkillBridge.setMailCapabilities(selected);
    render(state);
    const sendCheckbox = capabilityCheckbox(SEND_CAPABILITY);
    if (permissionDenied && sendCheckbox) sendCheckbox.checked = false;
    if (capabilitiesStatus) {
      if (permissionDenied) {
        capabilitiesStatus.textContent = "浏览器拒绝了 compose.send 权限请求，外发确认能力未启用；其余勾选项已保存";
      } else {
        capabilitiesStatus.textContent = selected.length > 0 ? `已保存，当前授予 ${selected.length} 项能力` : "已保存，当前未授予任何能力（全部邮件 route 将失败关闭）";
      }
    }
  } catch (error) {
    if (capabilitiesStatus) capabilitiesStatus.textContent = `保存失败：${error instanceof Error ? error.message : "未知错误"}`;
    await refresh();
  }
});

void refresh();
