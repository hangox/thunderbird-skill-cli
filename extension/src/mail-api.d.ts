// 全部邮件能力域共用的集中式 WebExtension Mail API 环境类型（Task #33 platform
// 层收口：从 extension/src/mail/thunderbird-mail-api.d.ts 迁到这里）。当前
// 内容覆盖只读域需要的 accounts/folders/messages/messageDisplay；可逆/草稿域
// （compose、messages.update/move 等）需要的额外成员应该继续在**这个文件**
// 里用 TypeScript 的接口声明合并追加（同名 `interface Browser`/`MailFolder`
// 等在同一文件或不同文件里都会自动合并成员），不要再各自新建平行的
// ambient .d.ts——那样会导致同一批 WebExtension 类型分散在多处、互相不知道
// 对方已经声明过哪些字段。
//
// 刻意不编辑 `extension/src/bridge-api.d.ts`：那个文件只声明
// `browser.thunderbirdSkillBridge`（Experiment API 的类型），是完全独立的
// 关注点（本项目自己的特权桥接口，不是标准 WebExtension Mail API）；
// `declare const browser` 已经在那边声明过，这里不需要重复声明。
//
// 字段/方法覆盖范围基于官方 webextension-api.thunderbird.net 文档核对
// （见 reports/thunderbird-skill-cli-完整邮件能力方案-20260727.md 附录 A），
// 尚未在真实 Thunderbird 环境中做逐字段实测——`folder.id`/`message.id`
// 的具体运行时形状请见下方注释。
//
// 本文件不含任何顶层 import/export（纯 ambient 声明），因此对最终编译产物的
// classic-script 约束（仅 background.ts 有强制测试）没有影响，也不会引入任何
// 运行时代码，也不需要被 scripts/bundle-background.ts 的 MODULES 列表处理
// （.d.ts 不产生任何 .js 输出）。

/**
 * Thunderbird 文件夹标识符：MV2 下是稳定性较弱的字符串/数字 id，MV3
 * （128 ESR+）文档描述为可能的复合标识；`MailFolder.id` 官方原文明确
 * "does not remain after a restart"，重命名/移动后也会失效。这里刻意用
 * `unknown` 而非具体形状——业务代码永远不解释它的内部结构，只原样透传给
 * `browser.folders.*`/`browser.messages.query({folderId})`，真正的稳定引用
 * 是我们自己的 opaque folderRef（绑定 accountId + 这个不透明值）。
 */
type ThunderbirdFolderId = unknown;

interface MailIdentity {
  id: string;
  accountId: string;
  label?: string;
  name?: string;
  email?: string;
  replyTo?: string;
  organization?: string;
  default?: boolean;
}

interface MailFolder {
  id: ThunderbirdFolderId;
  accountId: string;
  name: string;
  path: string;
  specialUse?: string[];
  isFavorite?: boolean;
  isRoot?: boolean;
  isVirtual?: boolean;
  isUnified?: boolean;
  subFolders?: MailFolder[];
}

interface MailAccount {
  id: string;
  name: string;
  type: string;
  identities: MailIdentity[];
  rootFolder?: MailFolder;
  folders?: MailFolder[];
}

/**
 * `messages.query()` 支持的属性集合（MV3，见附录 A.4③：没有 `unread`，用
 * `read`；没有 `folder`，用 `folderId`）。这里只列出只读搜索/近期邮件需要
 * 的子集。
 */
interface MessageQueryInfo {
  accountId?: string;
  attachment?: boolean;
  author?: string;
  body?: string;
  flagged?: boolean;
  folderId?: ThunderbirdFolderId;
  fromDate?: Date;
  fullText?: string;
  headerMessageId?: string;
  includeSubFolders?: boolean;
  junk?: boolean;
  messagesPerPage?: number;
  read?: boolean;
  recipients?: string;
  returnMessageListId?: boolean;
  subject?: string;
  tags?: string[];
  toDate?: Date;
}

interface MessageHeader {
  id: number;
  author: string;
  bccList: string[];
  ccList: string[];
  date: Date;
  external: boolean;
  flagged: boolean;
  folder?: MailFolder;
  headerMessageId: string;
  headersOnly?: boolean;
  junk: boolean;
  junkScore: number;
  new: boolean;
  priority: number;
  read: boolean;
  recipients: string[];
  size: number;
  subject: string;
  tags: string[];
  accountId?: string;
}

interface MessageList {
  id: string | null;
  messages: MessageHeader[];
}

interface MessagePart {
  partName?: string;
  body?: string;
  contentType?: string;
  headers?: Record<string, string[]>;
  name?: string;
  size?: number;
  parts?: MessagePart[];
}

interface MessageAttachment {
  contentType: string;
  name: string;
  partName: string;
  size: number;
}

interface MessageDisplayOpenOptions {
  messageId: number;
  location?: "tab" | "window" | "messageDisplayAction";
  active?: boolean;
}

interface MessageDisplayTab {
  tabId?: number;
  windowId?: number;
}

/**
 * 可逆域（Task #30/mail-write）新增成员：`messages.update`/`messages.move`
 * 用标准 `messagesUpdate`/`messagesMove` 权限（manifest.json 已申请）；
 * `getAttachmentFile` 用 `messagesRead` 已覆盖的能力返回整份 `File`（附件没有
 * 官方流式接口，见 docs/09 §A.5，内存风险由 route 层 10 MiB 总量上限约束）。
 */
interface MessageUpdateProperties {
  read?: boolean;
  flagged?: boolean;
  junk?: boolean;
  tags?: string[];
}

/** `messages.move()` 的目的地：官方文档用 `MailFolder` 形状（至少含 accountId/path），这里复用已声明的 `MailFolder`。`isUserAction` 是 TB 137+ 才有的可选项，本仓库不假设它存在。 */
interface MessageMoveOptions {
  isUserAction?: boolean;
}

/**
 * compose 域（草稿/外发，`compose`/`compose.save` 权限已申请）。
 *
 * `compose.send`（Task #44，0.4.0）是独立于 `compose`/`compose.save` 的可选
 * 权限（manifest.json 的 `optional_permissions`，不在常驻 `permissions`
 * 里）：官方文档明确 `compose.sendMessage()` 需要 `compose.send`
 * （`webextension-api.thunderbird.net` compose 页 sendMessage 条目标注
 * "Required permissions: compose.send"，TB 90 起可用），且该权限属于可通过
 * `permissions.request()`/`permissions.remove()`/`permissions.contains()`
 * 在运行时管理的 OptionalPermission（同上 permissions 页 request() 条目，
 * 非 PermissionNoPrompt/PermissionPrivileged 类型）。默认不在 manifest 常驻
 * permissions 里意味着用户首次启用外发能力前，`compose.sendMessage()`
 * 物理不可用；`mail/send.ts` 的 `draftsSendConfirm` 在真正调用它之前，会
 * 额外用 `browser.permissions.contains({permissions:["compose.send"]})`
 * 独立确认——不信任"capability 系统里 mail.send-confirmed.v1 已授予"就
 * 等于"浏览器层权限也已授予"这个假设，两者是可能互相漂移的两套独立状态
 * （例如用户可能绕过 options 页面、直接在 Thunderbird 自己的插件管理页面
 * 撤销权限）。
 *
 * 实测证据（Task #45）：在全新隔离、无账号、无 SMTP 出口的 Thunderbird
 * profile 中用临时诊断桩直接调用过 `browser.compose.beginNew()`/
 * `sendMessage()`（实验代码验证后已完整 revert，不在任何提交里）——未持有
 * `compose.send` 时，`typeof browser.compose.sendMessage === "undefined"`：
 * 这个方法在真实 Thunderbird 里根本不存在于 `compose` 命名空间下，调用会
 * 抛 `TypeError: browser.compose.sendMessage is not a function`，
 * `permissions.contains()` 如实返回 `false`。也就是说权限缺失表现为"方法
 * 整体不存在"，而不是"方法存在但拒绝执行"——比后者更强的物理保证。
 *
 * `ComposeDetails` 字段覆盖范围基于官方文档核对的子集，只列出草稿/外发域
 * 实际用到的字段。
 */
interface ComposeDetails {
  identityId?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
  subject?: string;
  body?: string;
  plainTextBody?: string;
  isPlainText?: boolean;
  relatedMessageId?: number;
  type?: string;
  isModified?: boolean;
  /** 本轮草稿不支持内联新增附件（见 mail/drafts.ts 头部说明），这里只在 send.ts 里用它做 attachmentDigest 摘要的输入——空数组即代表"当前草稿无附件"的稳定摘要。 */
  attachments?: readonly unknown[];
}

interface ComposeTab {
  id: number;
  windowId?: number;
}

/** `saveMessage()` 官方返回 `messages` 数组"通常恰好一个元素"，但 TB<142 受 FCC 配置影响可能多于一个（docs/09 §A.5）；业务代码不得假设 `messages[0]` 必然存在或唯一，必须显式校验。 */
interface ComposeSaveResult {
  messages: MessageHeader[];
  mode: "draft" | "template" | string;
}

type ComposeSendMode = "default" | "sendLater" | "sendNow";

interface ComposeSendResult {
  messages?: MessageHeader[];
  mode?: string;
}

/** `permissions.request/remove/contains()` 的入参形状；本仓库只用 `permissions` 字段（`compose.send`），不涉及 `origins`。 */
interface PermissionsRequest {
  permissions?: string[];
  origins?: string[];
}

interface Browser {
  /**
   * 标准 WebExtension `permissions` API（TB 55+，request 需要用户手势触发，
   * 例如 options 页面表单提交事件——见 `extension/src/options.ts`）。
   * 与 `thunderbirdSkillBridge` 那个 Experiment API 是完全独立的两套权限
   * 体系：Experiment API 的"完全访问"授权发生在扩展安装时，一次性、全有
   * 全无；这里的 `permissions` 是标准 WebExtension 可选权限，按单个字符串
   * 粒度、可在扩展运行期间随时请求/撤销，且只影响非特权（`background.ts`
   * 等普通背景页作用域）代码能调用哪些标准 `browser.*` 方法——两者不冲突、
   * 不互相包含。
   */
  permissions: {
    request(permissions: PermissionsRequest): Promise<boolean>;
    remove(permissions: PermissionsRequest): Promise<boolean>;
    contains(permissions: PermissionsRequest): Promise<boolean>;
  };
  accounts: {
    list(includeFolders?: boolean): Promise<MailAccount[]>;
    get(accountId: string, includeFolders?: boolean): Promise<MailAccount | null>;
  };
  folders: {
    query(queryInfo?: Record<string, unknown>): Promise<MailFolder[]>;
    get(folderId: ThunderbirdFolderId, includeSubFolders?: boolean): Promise<MailFolder>;
    getSubFolders(folderId: ThunderbirdFolderId): Promise<MailFolder[]>;
  };
  messages: {
    query(queryInfo: MessageQueryInfo): Promise<MessageList>;
    continueList(messageListId: string): Promise<MessageList>;
    get(messageId: number): Promise<MessageHeader>;
    getFull(messageId: number): Promise<MessagePart>;
    getRaw(messageId: number): Promise<string>;
    listAttachments(messageId: number): Promise<MessageAttachment[]>;
    getAttachmentFile(messageId: number, partName: string): Promise<File>;
    update(messageId: number, newProperties: MessageUpdateProperties): Promise<void>;
    move(messageIds: number[], destination: MailFolder, options?: MessageMoveOptions): Promise<void>;
  };
  messageDisplay: {
    open(options: MessageDisplayOpenOptions): Promise<MessageDisplayTab>;
  };
  compose: {
    beginNew(messageIdOrDetails?: number | ComposeDetails, details?: ComposeDetails): Promise<ComposeTab>;
    getComposeDetails(tabId: number): Promise<ComposeDetails>;
    setComposeDetails(tabId: number, details: ComposeDetails): Promise<void>;
    saveMessage(tabId: number, options?: { mode?: "draft" | "template" }): Promise<ComposeSaveResult>;
    sendMessage(tabId: number, options?: { mode?: ComposeSendMode }): Promise<ComposeSendResult>;
  };
  /** 仅用于探测 compose 标签页是否仍存活（"绑定活着的 compose tab"）；不申请额外 `tabs` 权限——`compose.*` 已隐含可对自己开出的 tab 调用这些方法。 */
  tabs: {
    get(tabId: number): Promise<{ id: number }>;
  };
}
