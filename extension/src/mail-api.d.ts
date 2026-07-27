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
 * compose 域（草稿/外发，`compose`/`compose.save` 权限已申请；`compose.send`
 * 权限刻意未申请，见 manifest.json 顶部说明与 docs/09 附录 A.1——`sendMessage`
 * 因此在真实 Thunderbird 环境中会因权限缺失而拒绝，这是"禁止真实发送"的
 * 物理保证，而不仅是代码层判断）。
 *
 * `ComposeDetails` 字段覆盖范围基于 docs/01 附录 A 核对的官方文档子集，只列出
 * 草稿/外发域实际用到的字段。
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

interface Browser {
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
