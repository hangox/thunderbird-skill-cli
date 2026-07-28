const serviceState = document.querySelector<HTMLElement>("#service-state");
const pairingState = document.querySelector<HTMLElement>("#pairing-state");
const clientId = document.querySelector<HTMLElement>("#client-id");
const pairingCode = document.querySelector<HTMLElement>("#pairing-code");
const pairingExpiry = document.querySelector<HTMLElement>("#pairing-expiry");
const pairingError = document.querySelector<HTMLElement>("#pairing-error");
const confirmButton = document.querySelector<HTMLButtonElement>("#confirm-pairing");
const revokeButton = document.querySelector<HTMLButtonElement>("#revoke-pairing");
const capabilitiesForm = document.querySelector<HTMLFormElement>("#capabilities-form");
const applyCapabilitiesButton = document.querySelector<HTMLButtonElement>("#apply-capabilities");
const capabilitiesStatus = document.querySelector<HTMLElement>("#capabilities-status");

type DisplayedIntent = Readonly<{
  intentId: string;
  code: string;
  clientId: string | null;
  expiresAt: string | null;
}>;

let displayedIntent: DisplayedIntent | null = null;

// Task #48：挑战码过期交互修复。此前 render() 只是把 state.pendingCode 原样
// 显示出来、confirmButton 只在"完全没有 pending"时禁用——一个已经过期但
// 尚未被后台清理的 pending（confirmPairing 会在过期时抛错，见 api.js
// `Date.parse(state.pending.expiresAt) <= Date.now()` 分支）在 UI 上和一个
// 仍然有效的 pending 长得一模一样，用户没有任何线索知道"已经点不动了"。
//
// 这里用一个本地倒计时（每秒 tick 一次）持续对照 displayedIntent.expiresAt
// 与真实时钟：仍在有效期内时显示剩余秒数；一旦本地判定已过期，立即禁用确认
// 按钮、把状态区域标成"已过期"，并触发一次 refresh() 向后台核实最新状态——
// 不假设后台会主动清理过期 pending，前端自己先 fail-closed。这个 refresh()
// 调用只发生在"倒计时 tick 观察到刚跨越过期线"这一个时刻，不会在 render()
// 每次被调用时都重新 refresh（否则一个后台从不清理的过期 pending 会导致
// render→refresh→render 无限循环）。
let countdownTimer: ReturnType<typeof setInterval> | null = null;
const COUNTDOWN_TICK_MS = 1000;

function clearCountdownTimer(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// Task #48：既显示可读的本地到期时刻（用户核对"是不是已经过了那个点"），
// 也显示秒级倒计时（用户核对"还剩多久"）——只给相对剩余秒数不够直观：
// 页面可能已经在后台停留了很久，用户单看"剩余 X 秒"无法判断这是不是一个
// 刚刷新出来的新数字。
function formatExpiryStatus(expiresAtIso: string, remainingMs: number): string {
  const localTime = new Date(expiresAtIso).toLocaleTimeString();
  return `到期时间 ${localTime}（剩余 ${Math.max(0, Math.ceil(remainingMs / 1000))} 秒）`;
}

function markExpiredAndResync(): void {
  clearCountdownTimer();
  if (confirmButton) confirmButton.disabled = true;
  if (pairingExpiry) pairingExpiry.textContent = "已过期，请重新发起配对";
  void refresh();
}

function tickCountdown(): void {
  if (!displayedIntent?.expiresAt) return;
  const remainingMs = Date.parse(displayedIntent.expiresAt) - Date.now();
  if (remainingMs <= 0) {
    markExpiredAndResync();
    return;
  }
  if (pairingExpiry) pairingExpiry.textContent = formatExpiryStatus(displayedIntent.expiresAt, remainingMs);
}

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

  clearCountdownTimer();
  displayedIntent = state.pendingIntentId && state.pendingCode
    ? Object.freeze({ intentId: state.pendingIntentId, code: state.pendingCode, clientId: state.pendingClientId, expiresAt: state.pendingExpiresAt })
    : null;

  if (!displayedIntent) {
    if (confirmButton) confirmButton.disabled = true;
    if (pairingExpiry) pairingExpiry.textContent = "—";
  } else if (!displayedIntent.expiresAt) {
    // 理论上 confirmPairing 写入的 pending 恒带 expiresAt；仍保留这条兜底
    // 分支只是为了不让缺失字段的异常数据把整页渲染打挂。
    if (confirmButton) confirmButton.disabled = false;
    if (pairingExpiry) pairingExpiry.textContent = "无到期时间信息";
  } else {
    const remainingMs = Date.parse(displayedIntent.expiresAt) - Date.now();
    if (remainingMs <= 0) {
      if (confirmButton) confirmButton.disabled = true;
      if (pairingExpiry) pairingExpiry.textContent = "已过期，请重新发起配对";
      // 注意：这里不调用 refresh()——初次渲染就已过期（例如页面重新加载
      // 时才发现）不代表后台状态本身有变化，重复 refresh 只会拿到同样已
      // 过期的 pending，陷入 render→refresh→render 空转。只有下面倒计时
      // tick 观察到"刚刚跨越过期线"这一次性事件才需要主动核实后台。
    } else {
      if (confirmButton) confirmButton.disabled = false;
      if (pairingExpiry) pairingExpiry.textContent = formatExpiryStatus(displayedIntent.expiresAt, remainingMs);
      countdownTimer = setInterval(tickCountdown, COUNTDOWN_TICK_MS);
    }
  }

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

// Task #48：`confirmInFlight` 防止用户在一次确认请求尚未落地前重复点击
// （例如网络/IPC 有延迟时连续点两下）产生第二次并发的 confirmPairing 调用。
// 必须在 click handler 一开始、任何 await 之前就同步置位并禁用按钮——
// 如果放在第一个 await 之后才置位，两次几乎同时发生的点击都可能在各自的
// await 前读到 confirmInFlight === false，从而双双通过这道门。
let confirmInFlight = false;

confirmButton?.addEventListener("click", async () => {
  const shown = displayedIntent;
  if (!shown || confirmInFlight) return;
  confirmInFlight = true;
  if (confirmButton) confirmButton.disabled = true;
  if (pairingError) pairingError.textContent = "";
  try {
    const current = await browser.thunderbirdSkillBridge.getState();
    if (current.pendingIntentId !== shown.intentId || current.pendingCode !== shown.code || current.pendingClientId !== shown.clientId) {
      render(current);
      return;
    }
    // Task #48：此前这里没有 try/catch——confirmPairing 在挑战码过期（或
    // intentId/code 校验失败）时会 reject（见 api.js confirmPairing 分支），
    // 而这个未捕获的 rejection 在 click handler 里静默消失，用户点了按钮却
    // 界面毫无反应，唯一线索是浏览器控制台里一条不会展示给用户看的
    // unhandled rejection。现在捕获异常、把 message 展示在页面上，并
    // refresh() 拉取权威状态重新渲染（不假设这次失败前端已经知道后台的
    // 最新真实状态）。
    try {
      render(await browser.thunderbirdSkillBridge.confirmPairing(shown.intentId, shown.code));
    } catch (error) {
      if (pairingError) pairingError.textContent = `确认失败：${error instanceof Error ? error.message : "未知错误"}`;
      await refresh();
    }
  } finally {
    // render()/refresh() 在上面各分支里已经根据最新状态设置了正确的
    // disabled 值（例如确认成功后不再有 displayedIntent、或失败后维持
    // 原有过期/有效判定）；这里只需要放开重入门禁本身。
    confirmInFlight = false;
  }
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
  // Task #45 收敛：这次提交是否真的在浏览器层"新"拿到了 compose.send 权限——
  // 只有这种情况下，后续 setMailCapabilities() 失败时才需要回滚浏览器权限；
  // 如果权限提交前就已经持有（`permissions.request()` 对已持有的权限会
  // 直接返回 true、不弹窗），保存失败不应该把用户已有的权限一并撤销，那会
  // 把一次不相关的失败放大成权限丢失。因此必须先用 contains() 拍一次
  // "提交前基线"，而不是简单地用 request() 的返回值判断"是不是新拿到的"。
  let acquiredPermissionThisSubmit = false;
  try {
    if (selected.includes(SEND_CAPABILITY)) {
      const alreadyHeld = await browser.permissions.contains({ permissions: [COMPOSE_SEND_PERMISSION] });
      const granted = await browser.permissions.request({ permissions: [COMPOSE_SEND_PERMISSION] });
      if (!granted) {
        permissionDenied = true;
        selected = selected.filter((value) => value !== SEND_CAPABILITY);
      } else if (!alreadyHeld) {
        acquiredPermissionThisSubmit = true;
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
    // 浏览器权限弹窗已经同意（acquiredPermissionThisSubmit=true），但随后
    // setMailCapabilities() 失败：如果不回滚，会留下"浏览器层已经真实持有
    // compose.send，但我们自己的 capabilities 记录里从未出现过
    // mail.send-confirmed.v1"这种悬空授权——用户在 UI 上看到"保存失败"，
    // 会合理地认为外发能力没有开启，但物理权限其实已经打开了。
    if (acquiredPermissionThisSubmit) {
      await browser.permissions.remove({ permissions: [COMPOSE_SEND_PERMISSION] }).catch(() => {});
    }
    if (capabilitiesStatus) capabilitiesStatus.textContent = `保存失败：${error instanceof Error ? error.message : "未知错误"}`;
    await refresh();
  }
});

void refresh();
