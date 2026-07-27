// 只读邮件域 handler 注册表：把 `src/contracts/routes.ts` 里属于
// `mail.read.v1` 的 7 条 route id 映射到本域实现的业务函数，签名对齐
// `extension/src/background.ts` 里的 `MailRouteBusinessHandler`
// = `(body: unknown, context: MailAdapterContext) => Promise<unknown>`。
//
// 接线方式（已落地，非设计中）：`background.ts` 用普通 ES `import` 引用
// `READ_MAIL_ROUTE_HANDLERS`；`npm run build:extension` 里 `tsc` 之后紧跟
// `scripts/bundle-background.ts` 把 background.ts 与它依赖的
// refs.ts/schema.ts/mail/*.ts 编译产物确定性拼接成一个零 import/export 的
// classic script，覆盖写回 `extension/dist/background.js`（`manifest.json`
// 保持单一 classic `background.scripts:[dist/background.js]`，没有改成多个
// `<script>` 共享全局作用域，也没有切换成 `type:"module"`）。
// `extension/src/background.ts` 的 `MAIL_ROUTE_READINESS`/
// `MAIL_ROUTE_BUSINESS_HANDLERS` 直接从这里的 `READ_MAIL_ROUTE_HANDLERS`
// 派生，不是两张手写表；`onOperation` 事件已携带 `clientId`/`pairingEpoch`
// （取自 api.js 已验证的 securityRequest），`extension/src/mail/state.ts`
// 的 `MailAdapterContext` 两个字段都是必填，不存在"未区分 client"的降级
// 路径；`handleOperation` 的 catch 分支优先读取 `error.code`
// （duck-typing，不要求 `instanceof MailAdapterError`）透传给 CLI。
// `test/bundle.test.mjs` 直接加载真实 bundle 产物用 vm 驱动，断言这 7 个
// handler 真的被拼接进最终产物且可分发（不是只测 TS 编译通过）。
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
