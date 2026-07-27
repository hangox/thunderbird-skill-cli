// ---------------------------------------------------------------------------
// 邮件 route handler 接口骨架（仅类型 + 未实现登记表）。
//
// 实际的 HTTP 路由匹配、认证/风险/capability 校验与 dispatch 全部发生在
// Experiment 特权作用域（extension/bridge/api.js），因为只有那里持有
// loopback server 与 XPCOM 权限；background.ts 运行在普通 MV3 背景页作用域，
// 拿不到这些权限，也不应该拿到。这里只声明后续实现 PR（只读/可逆/草稿-外发
// 能力）要遵守的稳定接口形状，并把"哪些 route 尚未接线"列成一张类型检查过的
// 登记表，供集成阶段核对覆盖率——把某个 route 的值从 "not-implemented" 换成
// 真正的 handler 函数引用，就是接入该能力的唯一步骤，不需要改动其他任何地方。
//
// 范围裁决（team-lead，2026-07-27）：v0.3.0 不实现永久删除与 watch，因此
// 这里不登记 messages.delete.prepare/confirm、watch.poll——它们在
// src/contracts/routes.ts 里也没有对应 route。
// ---------------------------------------------------------------------------

// 注：background.js 以 classic script（非 module）形式被 manifest 直接加载，
// 编译产物不得含任何顶层 import/export（见 test/extension.test.mjs）。类型
// 声明（type/interface）编译时会被完全擦除，天然安全；下面两个 const 特意
// 不加 export，只作为本文件内的骨架登记表。

/** 与 extension/bridge/api.js 里镜像实现的 handler 签名一致：认证/风险/capability/schema 校验已在 dispatch 管线完成，handler 只处理业务逻辑。 */
type MailRouteHandlerStatus = "not-implemented" | "implemented";

const MAIL_ROUTE_IDS = [
  "accounts.list",
  "folders.list",
  "messages.search",
  "messages.recent",
  "messages.get",
  "messages.open",
  "messages.mark",
  "messages.move",
  "messages.trash",
  "attachments.list",
  "attachments.save",
  "drafts.create",
  "drafts.update",
  "drafts.open",
  "drafts.send.prepare",
  "drafts.send.confirm",
  "operations.get",
] as const;

type MailRouteId = (typeof MAIL_ROUTE_IDS)[number];

// 本轮（0.3.0 契约冻结 + 传输/Experiment 特权桥）只交付路由骨架，不接线任何
// 真实 mail adapter；因此全部登记为 "not-implemented"。后续实现只读/可逆/
// 草稿-外发能力的 PR 把对应条目改成 "implemented" 并在 extension/bridge/api.js
// 的 ROUTE_REGISTRY 里把 stub handler 换成真实实现，二者必须同步。
const MAIL_ROUTE_READINESS: Readonly<Record<MailRouteId, MailRouteHandlerStatus>> = {
  "accounts.list": "not-implemented",
  "folders.list": "not-implemented",
  "messages.search": "not-implemented",
  "messages.recent": "not-implemented",
  "messages.get": "not-implemented",
  "messages.open": "not-implemented",
  "messages.mark": "not-implemented",
  "messages.move": "not-implemented",
  "messages.trash": "not-implemented",
  "attachments.list": "not-implemented",
  "attachments.save": "not-implemented",
  "drafts.create": "not-implemented",
  "drafts.update": "not-implemented",
  "drafts.open": "not-implemented",
  "drafts.send.prepare": "not-implemented",
  "drafts.send.confirm": "not-implemented",
  "operations.get": "not-implemented",
};

// 真正的业务 handler 登记表：key 与 MAIL_ROUTE_READINESS 一一对应，值为
// `undefined`（尚未接线）或一个用标准 MailExtension API（browser.accounts/
// browser.messages/browser.compose/...）实现业务逻辑的函数。本轮全部
// "not-implemented"，因此这里必然是空对象；后续实现某条能力的 PR 同时把
// MAIL_ROUTE_READINESS 对应项改成 "implemented" 并在这里补上函数引用，
// handleOperation 会据此路由，不需要改动分发逻辑本身。
type MailRouteBusinessHandler = (body: unknown, context: { capability: string }) => Promise<unknown>;
const MAIL_ROUTE_BUSINESS_HANDLERS: Partial<Record<MailRouteId, MailRouteBusinessHandler>> = {};

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

function isMailRouteId(value: string): value is MailRouteId {
  return (MAIL_ROUTE_IDS as readonly string[]).includes(value);
}

/**
 * api.js 通过 onOperation 转发已认证/已过 capability 门禁的邮件 route
 * 请求；这里是唯一允许调用标准 MailExtension API（browser.accounts/
 * browser.messages/browser.compose/...)的地方，api.js 本身不含任何邮件业务
 * 语义（禁止 XPCOM MailServices 调用）。本轮 MAIL_ROUTE_READINESS 全部
 * "not-implemented"，因此该函数目前对全部请求统一响应 E_NOT_IMPLEMENTED，
 * 但完整的转发/响应回路是真实可用的，供后续实现能力的 PR 直接复用。
 */
async function handleOperation(token: string, routeId: string, capability: string, bodyJson: string): Promise<void> {
  if (!isMailRouteId(routeId) || MAIL_ROUTE_READINESS[routeId] !== "implemented") {
    await browser.thunderbirdSkillBridge.failOperation(token, "E_NOT_IMPLEMENTED", "该邮件能力尚未实现");
    return;
  }
  const handler = MAIL_ROUTE_BUSINESS_HANDLERS[routeId];
  if (!handler) {
    // readiness 与 handler 登记表本身出现漂移：视为未实现失败关闭，不猜测执行。
    console.error(`Thunderbird Skill Bridge：route ${routeId} 标记为 implemented 但没有登记 handler`);
    await browser.thunderbirdSkillBridge.failOperation(token, "E_NOT_IMPLEMENTED", "该邮件能力尚未实现");
    return;
  }
  try {
    const body: unknown = JSON.parse(bodyJson);
    const result = await handler(body, { capability });
    await browser.thunderbirdSkillBridge.respondToOperation(token, JSON.stringify(result));
  } catch (error) {
    await browser.thunderbirdSkillBridge.failOperation(token, "E_INTERNAL", error instanceof Error ? error.message : "未知内部错误");
  }
}

/**
 * 启动期一次性核对：api.js 的 MAIL_ROUTES 与本文件的 MAIL_ROUTE_IDS 是两个
 * 独立维护的镜像（跨 tsconfig rootDir 与特权作用域，无法共享同一份编译产物），
 * 这里用运行时自检代替"人工保证不漂移"——任何一侧多出或缺失 route id 都会
 * 在启动日志中给出明确诊断，而不是静默地在某条 route 上出现认知错误。
 */
async function verifyMailRouteRegistry(): Promise<boolean> {
  try {
    const remoteIds = await browser.thunderbirdSkillBridge.listMailRoutes();
    const remoteSet = new Set(remoteIds);
    const localSet = new Set<string>(MAIL_ROUTE_IDS);
    const missingLocally = remoteIds.filter((id) => !localSet.has(id));
    const missingRemotely = MAIL_ROUTE_IDS.filter((id) => !remoteSet.has(id));
    if (missingLocally.length > 0 || missingRemotely.length > 0) {
      console.error("Thunderbird Skill Bridge：邮件 route 登记表与特权桥 MAIL_ROUTES 不一致", { missingLocally, missingRemotely });
      return false;
    }
    return true;
  } catch (error) {
    console.error("Thunderbird Skill Bridge：无法核对邮件 route 登记表", error);
    return false;
  }
}

async function startBridge(): Promise<BridgeState> {
  try {
    const state = await browser.thunderbirdSkillBridge.start();
    console.info("Thunderbird Skill Bridge：Phase 1 回环服务已启动");
    browser.thunderbirdSkillBridge.onOperation.addListener(handleOperation);
    void verifyMailRouteRegistry();
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
