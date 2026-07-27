// ---------------------------------------------------------------------------
// 邮件 route handler 分发中枢。
//
// 实际的 HTTP 路由匹配、认证/风险/capability 校验与 dispatch 全部发生在
// Experiment 特权作用域（extension/bridge/api.js），因为只有那里持有
// loopback server 与 XPCOM 权限；background.ts 运行在普通 MV3 背景页作用域，
// 拿不到这些权限，也不应该拿到——这里是唯一允许调用标准 MailExtension API
// （browser.accounts/browser.messages/browser.compose/...）的地方。
//
// 编译产物约束：background.js 以 classic script（非 module）形式被 manifest
// 直接加载，最终产物不得含任何顶层 import/export（见 test/extension.test.mjs）。
// 本文件源码里的 `import` 语句会在 `npm run build:extension` 的
// `scripts/bundle-background.ts` 步骤里，与它依赖的 refs.ts/schema.ts/
// mail/*.ts 一起被确定性拼接成一个零 import/export 的文件，覆盖写回
// extension/dist/background.js——源码层面仍然是普通、可静态检查的 ES 模块。
//
// 范围裁决（team-lead，2026-07-27）：v0.3.0 不实现永久删除与 watch，因此
// 这里不登记 messages.delete.prepare/confirm、watch.poll——它们在
// src/contracts/routes.ts 里也没有对应 route。
// ---------------------------------------------------------------------------

import { READ_MAIL_ROUTE_HANDLERS } from "./mail/index.js";
import { mailRefStore } from "./mail/state.js";
import type { MailAdapterContext } from "./mail/state.js";

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
  "attachments.fetch",
  "drafts.create",
  "drafts.update",
  "drafts.open",
  "drafts.send.prepare",
  "drafts.send.confirm",
  "operations.get",
  "operations.undo",
] as const;

type MailRouteId = (typeof MAIL_ROUTE_IDS)[number];

/** handler 签名：与 extension/src/mail/state.ts 的 `MailAdapterContext` 对齐，返回值可以是任意 JSON 可序列化结果（各 handler 自己声明更精确的返回类型，靠返回类型协变满足这里）。 */
type MailRouteBusinessHandler = (body: unknown, context: MailAdapterContext) => Promise<unknown>;

function isMailRouteId(value: string): value is MailRouteId {
  return (MAIL_ROUTE_IDS as readonly string[]).includes(value);
}

function isKnownHandlerKey(value: string): value is keyof typeof READ_MAIL_ROUTE_HANDLERS {
  return Object.hasOwn(READ_MAIL_ROUTE_HANDLERS, value);
}

// 只读邮件域（Task #29）的 7 个 handler 从 extension/src/mail/index.ts 的
// 单一登记表接入；readiness 与 handler 表由同一份数据源派生，不存在"手动
// 同步两张表"的漂移窗口——新增一个域只需要在 mail/index.ts 里补一张类似的
// 登记表并在这里 import 合并即可。
const MAIL_ROUTE_READINESS: Record<MailRouteId, MailRouteHandlerStatus> = Object.fromEntries(
  MAIL_ROUTE_IDS.map((id) => [id, isKnownHandlerKey(id) ? "implemented" : "not-implemented"]),
) as Record<MailRouteId, MailRouteHandlerStatus>;

const MAIL_ROUTE_BUSINESS_HANDLERS: Partial<Record<MailRouteId, MailRouteBusinessHandler>> = { ...READ_MAIL_ROUTE_HANDLERS };

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

/** MailAdapterError 携带的 code 是 background.ts 唯一信任的错误码来源；未知形状统一降级为 E_INTERNAL，不猜测语义。 */
function extractErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "E_INTERNAL";
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知内部错误";
}

/**
 * api.js 通过 onOperation 转发已认证/已过 capability 门禁的邮件 route
 * 请求，随事件一起携带 clientId/pairingEpoch（取自 api.js 已验证的
 * securityRequest）。这里按 MAIL_ROUTE_READINESS 路由到已接入的业务
 * handler；未实现或 handler 缺失一律失败关闭为 E_NOT_IMPLEMENTED，不猜测
 * 执行。handler 抛出的错误优先读取其 `code` 字段透传给 CLI，而不是无条件
 * 折叠成 E_INTERNAL。
 */
async function handleOperation(token: string, routeId: string, capability: string, bodyJson: string, clientId: string, pairingEpoch: string): Promise<void> {
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
    const result = await handler(body, { capability, clientId, pairingEpoch });
    await browser.thunderbirdSkillBridge.respondToOperation(token, JSON.stringify(result));
  } catch (error) {
    await browser.thunderbirdSkillBridge.failOperation(token, extractErrorCode(error), extractErrorMessage(error));
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
    // 配对撤销即等价于 epoch 推进（当前设计里只有这一条触发路径）：background
    // 是 opaque ref 绑定表（mailRefStore）的唯一持有者，收到通知后必须清空，
    // 否则旧 client 的 ref 会在重新配对的新 client 名下被错误复用。
    browser.thunderbirdSkillBridge.onPairingRevoked.addListener(() => { mailRefStore.clear(); });
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
