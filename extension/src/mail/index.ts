// 全部邮件域（只读 + 可逆/草稿/外发）handler 的单一注册表：把
// `src/contracts/routes.ts` 里全部 route id 映射到各域实现的业务函数，
// 签名对齐 `extension/src/background.ts` 里的 `MailRouteBusinessHandler`
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
// `test/bundle.test.mjs` 直接加载真实 bundle 产物用 vm 驱动，断言这些
// handler 真的被拼接进最终产物且可分发（不是只测 TS 编译通过）。
//
// 命名说明（Task #30/mail-write 追加，2026-07-27）：这个导出常量的名字
// `READ_MAIL_ROUTE_HANDLERS` 是 `background.ts`（不在本任务改动范围内）
// 已经在用的具名 import，为了不touch background.ts，可逆/草稿/外发域
// （mark/move/trash/undo/drafts/send/operations/attachments save&fetch）
// 的 handler 直接并入这同一个常量，而不是另开一个 background.ts 不会读取
// 的新导出。名字因此不再准确反映内容（不止"只读"），这是刻意的兼容性选择，
// 而不是疏漏；后续如果有 PR 需要顺带重命名，必须与 background.ts 的 import
// 语句一起改。
import { accountsList } from "./accounts.js";
import { attachmentsList } from "./attachments.js";
import { attachmentsFetch, attachmentsSave } from "./attachments-write.js";
import { draftsCreate, draftsOpen, draftsUpdate } from "./drafts.js";
import { foldersList } from "./folders.js";
import { messagesGet, messagesOpen } from "./messages.js";
import { messagesMark, messagesMove, messagesTrash } from "./mutate.js";
import { operationsGet } from "./operations.js";
import { messagesRecent, messagesSearch } from "./search.js";
import { draftsSendConfirm, draftsSendPrepare } from "./send.js";
import { operationsUndo } from "./undo.js";

/** key 与 `extension/src/background.ts` 的 `MailRouteId`、`src/contracts/routes.ts` 的 route id 一一对应。 */
export const READ_MAIL_ROUTE_HANDLERS = {
  "accounts.list": accountsList,
  "folders.list": foldersList,
  "messages.search": messagesSearch,
  "messages.recent": messagesRecent,
  "messages.get": messagesGet,
  "messages.open": messagesOpen,
  "attachments.list": attachmentsList,
  "messages.mark": messagesMark,
  "messages.move": messagesMove,
  "messages.trash": messagesTrash,
  "attachments.save": attachmentsSave,
  "attachments.fetch": attachmentsFetch,
  "drafts.create": draftsCreate,
  "drafts.update": draftsUpdate,
  "drafts.open": draftsOpen,
  "drafts.send.prepare": draftsSendPrepare,
  "drafts.send.confirm": draftsSendConfirm,
  "operations.get": operationsGet,
  "operations.undo": operationsUndo,
} as const;
