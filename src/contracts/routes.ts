import type { RiskClass } from "./commands.js";

// 邮件 route 的单一权威来源：CLI（未来 src/commands/*）、扩展 protocol 层
// （extension/src/protocol.ts）与 Experiment 特权桥（extension/bridge/api.js）
// 三方都必须从这里读取 method/path/risk/capability/body 上限，禁止在各层
// 重新声明或推断这些静态元数据。变更此文件属于跨模块契约变更。

export const MAIL_ROUTE_PREFIX = "/v1/mail/" as const;

// 全部邮件 route 固定 POST + JSON body（即便语义上是"列表"查询也接受 `{}`），
// 原因：
// 1) 复用与 /v1/pairing/intents 完全一致的 canonical 签名/防重放/body-cap 管线，
//    不必再为 GET query string 单独设计一套规范化与签名规则；
// 2) bodySha256 对每个请求都有意义，不存在"GET 请求签名覆盖空 body"这种特例。
export type MailRouteMethod = "POST";

// 范围裁决（team-lead，2026-07-27）：v0.3.0 不实现永久删除、长连接/轮询式
// watch、calendar。本文件因此不冻结这三类能力的 route，MailCapability 也
// 不包含没有对应 route 的死能力标识（含曾计划中的
// mail.delete-confirmed.v1 / mail.watch.v1 / calendar.read.v1）。
export type MailCapability =
  | "mail.read.v1"
  | "mail.reversible.v1"
  | "draft.write.v1"
  | "mail.send-confirmed.v1";

export const MAIL_CAPABILITIES: readonly MailCapability[] = [
  "mail.read.v1",
  "mail.reversible.v1",
  "draft.write.v1",
  "mail.send-confirmed.v1",
] as const;

export interface MailRouteSpec {
  /** route 的稳定短 ID，用于日志、审计与 handler 注册表 key；不是 URL。 */
  readonly id: string;
  readonly method: MailRouteMethod;
  /** 完整 path，含 MAIL_ROUTE_PREFIX。 */
  readonly path: string;
  /** 对应 commands.ts 中的 CommandSpec.path，供 CLI 侧做 command → route 映射。 */
  readonly command: readonly string[];
  readonly risk: RiskClass;
  readonly capability: MailCapability;
  /**
   * 请求 body 硬上限（字节）。当前 Experiment loopback server 的全局
   * MAX_BODY_BYTES 是 16 KiB（extension/bridge/api.js），因此这里任何值都
   * 不得超过该全局上限；真正需要大 body 的能力（例如附件保存）按设计必须
   * 通过路径引用/流式传输而非内联 body 传递，不在这里放宽上限。
   */
  readonly maxRequestBodyBytes: number;
  /**
   * 响应 body 的契约上限（字节），当前 transport 层尚未对响应体做硬性截断
   * 强制（那是数据裁剪/分页策略的实现细节，属于只读/可逆能力实现 PR 的范围），
   * 这里只冻结契约数值，供实现方与测试对照。
   */
  readonly maxResponseBodyBytes: number;
  readonly summary: string;
}

const KIB = 1024;

export const MAIL_ROUTES: readonly MailRouteSpec[] = [
  {
    id: "accounts.list", method: "POST", path: `${MAIL_ROUTE_PREFIX}accounts.list`, command: ["accounts", "list"],
    risk: "read", capability: "mail.read.v1", maxRequestBodyBytes: 1 * KIB, maxResponseBodyBytes: 64 * KIB,
    summary: "列出授权账号与（可选）发件 identity",
  },
  {
    id: "folders.list", method: "POST", path: `${MAIL_ROUTE_PREFIX}folders.list`, command: ["folders", "list"],
    risk: "read", capability: "mail.read.v1", maxRequestBodyBytes: 2 * KIB, maxResponseBodyBytes: 256 * KIB,
    summary: "列出邮件文件夹树",
  },
  {
    id: "messages.search", method: "POST", path: `${MAIL_ROUTE_PREFIX}messages.search`, command: ["search"],
    risk: "read", capability: "mail.read.v1", maxRequestBodyBytes: 8 * KIB, maxResponseBodyBytes: 1024 * KIB,
    summary: "按元数据搜索邮件（includeBody 恒为 false）",
  },
  {
    id: "messages.recent", method: "POST", path: `${MAIL_ROUTE_PREFIX}messages.recent`, command: ["recent"],
    risk: "read", capability: "mail.read.v1", maxRequestBodyBytes: 2 * KIB, maxResponseBodyBytes: 512 * KIB,
    summary: "读取近期邮件摘要",
  },
  {
    id: "messages.get", method: "POST", path: `${MAIL_ROUTE_PREFIX}messages.get`, command: ["message", "get"],
    risk: "read", capability: "mail.read.v1", maxRequestBodyBytes: 2 * KIB, maxResponseBodyBytes: 320 * KIB,
    summary: "按 messageRef 读取正文（截断+分页 cursor）",
  },
  {
    id: "messages.open", method: "POST", path: `${MAIL_ROUTE_PREFIX}messages.open`, command: ["message", "open"],
    risk: "read", capability: "mail.read.v1", maxRequestBodyBytes: 1 * KIB, maxResponseBodyBytes: 4 * KIB,
    summary: "在 Thunderbird 消息窗口中打开邮件",
  },
  {
    id: "messages.mark", method: "POST", path: `${MAIL_ROUTE_PREFIX}messages.mark`, command: ["message", "mark"],
    risk: "reversible", capability: "mail.reversible.v1", maxRequestBodyBytes: 8 * KIB, maxResponseBodyBytes: 16 * KIB,
    summary: "修改已读/星标/标签并返回 undo token",
  },
  {
    id: "messages.move", method: "POST", path: `${MAIL_ROUTE_PREFIX}messages.move`, command: ["message", "move"],
    risk: "reversible", capability: "mail.reversible.v1", maxRequestBodyBytes: 8 * KIB, maxResponseBodyBytes: 16 * KIB,
    summary: "移动邮件并返回 undo token",
  },
  {
    id: "messages.trash", method: "POST", path: `${MAIL_ROUTE_PREFIX}messages.trash`, command: ["message", "trash"],
    risk: "reversible", capability: "mail.reversible.v1", maxRequestBodyBytes: 8 * KIB, maxResponseBodyBytes: 16 * KIB,
    summary: "移入废纸篓并返回 undo token",
  },
  // message delete（永久删除）本轮不冻结 route；commands.ts 中对应命令保持
  // phase: "future"，落到既有 E_NOT_IMPLEMENTED 兜底。
  {
    id: "attachments.list", method: "POST", path: `${MAIL_ROUTE_PREFIX}attachments.list`, command: ["attachments", "list"],
    risk: "read", capability: "mail.read.v1", maxRequestBodyBytes: 1 * KIB, maxResponseBodyBytes: 32 * KIB,
    summary: "列出附件元数据",
  },
  {
    id: "attachments.save", method: "POST", path: `${MAIL_ROUTE_PREFIX}attachments.save`, command: ["attachments", "save"],
    risk: "reversible", capability: "mail.reversible.v1", maxRequestBodyBytes: 4 * KIB, maxResponseBodyBytes: 8 * KIB,
    summary: "保存附件到显式目标目录（no-clobber）",
  },
  {
    id: "drafts.create", method: "POST", path: `${MAIL_ROUTE_PREFIX}drafts.create`, command: ["draft", "create"],
    risk: "reversible", capability: "draft.write.v1", maxRequestBodyBytes: 8 * KIB, maxResponseBodyBytes: 8 * KIB,
    summary: "创建草稿（正文经文件/stdin 引用，不内联大正文）",
  },
  {
    id: "drafts.update", method: "POST", path: `${MAIL_ROUTE_PREFIX}drafts.update`, command: ["draft", "update"],
    risk: "reversible", capability: "draft.write.v1", maxRequestBodyBytes: 8 * KIB, maxResponseBodyBytes: 8 * KIB,
    summary: "更新已有草稿",
  },
  {
    id: "drafts.open", method: "POST", path: `${MAIL_ROUTE_PREFIX}drafts.open`, command: ["draft", "open"],
    risk: "read", capability: "draft.write.v1", maxRequestBodyBytes: 1 * KIB, maxResponseBodyBytes: 4 * KIB,
    summary: "在 Thunderbird 撰写窗口打开草稿",
  },
  {
    id: "drafts.send.prepare", method: "POST", path: `${MAIL_ROUTE_PREFIX}drafts.send.prepare`, command: ["draft", "send"],
    risk: "external", capability: "mail.send-confirmed.v1", maxRequestBodyBytes: 2 * KIB, maxResponseBodyBytes: 16 * KIB,
    summary: "读取最新草稿并生成 confirmationId + revision/收件人/主题/附件摘要",
  },
  {
    id: "drafts.send.confirm", method: "POST", path: `${MAIL_ROUTE_PREFIX}drafts.send.confirm`, command: ["draft", "send"],
    risk: "external", capability: "mail.send-confirmed.v1", maxRequestBodyBytes: 2 * KIB, maxResponseBodyBytes: 8 * KIB,
    summary: "提交确认并发送；revision/收件人/主题/附件 digest 任一变化立即失效",
  },
  {
    id: "operations.get", method: "POST", path: `${MAIL_ROUTE_PREFIX}operations.get`, command: ["operations", "get"],
    risk: "read", capability: "mail.read.v1", maxRequestBodyBytes: 1 * KIB, maxResponseBodyBytes: 8 * KIB,
    summary: "查询 operationId 对应的异步/可撤销操作状态",
  },
  // watch（bounded JSONL 事件流）本轮不冻结 route；commands.ts 中对应命令
  // 保持 phase: "future"。
] as const;

export function findMailRoute(method: string, path: string): MailRouteSpec | undefined {
  return MAIL_ROUTES.find((route) => route.method === method && route.path === path);
}

export function findMailRoutesByCommand(command: readonly string[]): readonly MailRouteSpec[] {
  return MAIL_ROUTES.filter((route) => route.command.length === command.length && route.command.every((part, index) => part === command[index]));
}
