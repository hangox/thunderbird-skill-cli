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
  };
  messageDisplay: {
    open(options: MessageDisplayOpenOptions): Promise<MessageDisplayTab>;
  };
}
