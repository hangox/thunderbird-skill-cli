// 只读邮件域 handler 注册表：把 `src/contracts/routes.ts` 里属于
// `mail.read.v1` 的 7 条 route id 映射到本域实现的业务函数，签名对齐
// `extension/src/background.ts` 里的 `MailRouteBusinessHandler`
// = `(body: unknown, context: { capability: string }) => Promise<unknown>`。
//
// 这个文件本身目前**不会被任何人 import**——`background.ts` 编译产物必须是
// 零 import/export 的 classic script（`test/extension.test.mjs` 强制断言），
// 而这正是本任务在开工前向 team-lead 报告的第一个架构缺口：只读/可逆/草稿
// 三个域各自的 handler 都需要在 background.ts 里"从 not-implemented 换成真实
// 引用"才算真正接线，但 background.ts 不在本任务可改动范围内。
//
// 这个文件的作用是把"7 个函数分散在 5 个文件里"收拢成一张单一、可核对的
// 登记表，供集成阶段（Task #31 或 team-lead 指定的角色）在编辑 background.ts
// 时对照，而不是要求集成者去翻 5 个文件各自找函数名。集成步骤大致是：
//
//   1) background.ts 顶部（因为不能有 import）需要把本文件 7 个函数的实现
//      内联，或者——更现实的做法——把 background.ts 的加载方式从"单一
//      classic script"改成"manifest.json background.scripts 数组，按依赖
//      顺序列出 dist/mail/state.js、dist/mail/sanitize.js、
//      dist/mail/accounts.js、...、dist/mail/index.js、dist/background.js"，
//      让它们以多个 classic script 共享同一全局作用域（同页面内多个 <script>
//      的经典模式），background.js 里再通过形如 `globalThis.__mailReadHandlers`
//      的约定读取，而不是 ES import。两种方案都需要修改 manifest.json 与/或
//      background.ts，因此都需要 team-lead 或集成任务来做决策与落地。
//   2) MAIL_ROUTE_READINESS 对应 7 项从 "not-implemented" 改成 "implemented"。
//   3) MAIL_ROUTE_BUSINESS_HANDLERS 补上下面这 7 个引用。
//   4) `handleMailRouteRequest`/`onMailRouteRequest` 的签名需要从
//      `(token, routeId, capability, bodyJson)` 扩展为同时携带
//      `clientId`/`pairingEpoch`（api.js 的 `req.authenticated.securityRequest`
//      已经有这两个值），否则 `extension/src/mail/state.ts` 里的 ref
//      client/pairingEpoch 绑定会一直退化到"未区分 client"的降级路径
//      （见该文件 `resolveContext` 上方注释）。
//   5) `handleMailRouteRequest` 的 catch 分支目前无条件把任何抛出的错误映射成
//      `E_INTERNAL`；需要改成优先读取 `error instanceof MailAdapterError ?
//      error.code : "E_INTERNAL"`，否则这里抛出的 E_VALIDATION/E_NOT_FOUND
//      永远到不了 HTTP 响应（`extension/bridge/api.js` 的
//      `MAIL_ROUTE_ERROR_STATUS` 已经准备好了这些 code 的状态码映射，只是
//      background.ts 侧还没把 code 透传出去）。
//
// 以上 5 点已经完整同步给 team-lead（见本任务的 SendMessage 记录），这里不
// 重复整段说明，只保留一份可执行核对的登记表。
import { accountsList } from "./accounts.js";
import { attachmentsList } from "./attachments.js";
import { foldersList } from "./folders.js";
import { messagesGet, messagesOpen } from "./messages.js";
import { messagesRecent, messagesSearch } from "./search.js";

/** key 与 `extension/src/background.ts` 的 `MailRouteId`、`src/contracts/routes.ts` 的 route id 一一对应。 */
export const READ_MAIL_ROUTE_HANDLERS = {
  "accounts.list": accountsList,
  "folders.list": foldersList,
  "messages.search": messagesSearch,
  "messages.recent": messagesRecent,
  "messages.get": messagesGet,
  "messages.open": messagesOpen,
  "attachments.list": attachmentsList,
} as const;
