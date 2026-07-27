export type RiskClass = "read" | "reversible" | "external" | "destructive";
export type DeliveryPhase = "phase-1" | "phase-2" | "phase-3" | "phase-4" | "phase-5" | "phase-6" | "future";

export interface CommandSpec {
  path: readonly string[];
  summary: string;
  risk: RiskClass;
  phase: DeliveryPhase;
}

// 0.3.0 范围裁决（team-lead，2026-07-27）：本轮交付把 docs/09 原先按
// phase-2..phase-5 分批交付的邮件能力合并冻结进同一轮契约与传输/Experiment
// 特权桥实现，但明确排除三类能力——永久删除（message delete）、长连接/轮询式
// watch、calendar。这三类在 `phase` 字段上保持原有的 "future"/未纳入本轮，
// 也不在 src/contracts/routes.ts 里冻结对应 route；对应 CLI 命令继续走
// cli.ts 现有的 E_NOT_IMPLEMENTED 兜底，不接线任何真实调用路径。
// `phase` 字段保留用于对照历史设计文档的分阶段表述，本轮真正的门禁是
// extension/src/protocol.ts 与 extension/bridge/api.js 里按 route 静态声明
// 的 risk/capability：未授予对应 capability 一律 403 E_POLICY_DENIED 失败关闭。
export const COMMANDS: readonly CommandSpec[] = [
  { path: ["doctor"], summary: "诊断扩展、配对、版本和本地传输", risk: "read", phase: "phase-1" },
  { path: ["setup"], summary: "执行首次配对或重新配对", risk: "reversible", phase: "phase-1" },
  { path: ["status"], summary: "显示 Thunderbird 实例和会话状态", risk: "read", phase: "phase-1" },
  { path: ["xpi", "path"], summary: "输出随包分发的扩展 XPI 路径", risk: "read", phase: "phase-1" },
  { path: ["xpi", "reveal"], summary: "在 Finder 中定位该 XPI（仅 macOS）", risk: "read", phase: "phase-1" },
  { path: ["accounts", "list"], summary: "列出扩展授权的账号与发件身份（--include-identities 附带 identity）", risk: "read", phase: "phase-2" },
  { path: ["folders", "list"], summary: "列出邮件文件夹", risk: "read", phase: "phase-2" },
  { path: ["search"], summary: "搜索邮件元数据与预览", risk: "read", phase: "phase-2" },
  { path: ["message", "get"], summary: "按稳定引用读取邮件", risk: "read", phase: "phase-2" },
  { path: ["recent"], summary: "读取近期邮件摘要", risk: "read", phase: "phase-2" },
  { path: ["message", "open"], summary: "在 Thunderbird 中打开邮件", risk: "read", phase: "phase-2" },
  { path: ["message", "mark"], summary: "修改已读、星标或标签", risk: "reversible", phase: "phase-2" },
  { path: ["message", "move"], summary: "移动邮件并返回撤销凭据", risk: "reversible", phase: "phase-2" },
  { path: ["message", "trash"], summary: "移入废纸篓并返回撤销凭据", risk: "reversible", phase: "phase-2" },
  // 永久删除本轮不实现（team-lead 范围裁决）：未来实现时仍必须是 prepare/
  // confirm 两阶段并绑定 Thunderbird UI 人工确认回执，不接受 --force/--yes。
  { path: ["message", "delete"], summary: "永久删除邮件（本轮未实现，无对应 route）", risk: "destructive", phase: "future" },
  { path: ["draft", "create"], summary: "创建草稿，正文只接受文件或标准输入", risk: "reversible", phase: "phase-2" },
  { path: ["draft", "update"], summary: "更新已有草稿", risk: "reversible", phase: "phase-2" },
  { path: ["draft", "open"], summary: "在 Thunderbird 撰写窗口打开草稿", risk: "read", phase: "phase-2" },
  { path: ["draft", "send"], summary: "核验草稿并经明确确认后外发；--prepare 生成摘要、--confirm 提交", risk: "external", phase: "phase-3" },
  { path: ["attachments", "list"], summary: "列出附件元数据", risk: "read", phase: "phase-2" },
  { path: ["attachments", "save"], summary: "保存附件到显式目标目录", risk: "reversible", phase: "phase-2" },
  { path: ["operations", "get"], summary: "查询可逆/外发操作的当前状态", risk: "read", phase: "phase-2" },
  { path: ["calendar", "list"], summary: "列出日历（本轮未实现）", risk: "read", phase: "phase-3" },
  { path: ["calendar", "events"], summary: "查询日历事件（本轮未实现）", risk: "read", phase: "phase-3" },
  // watch 本轮不实现（team-lead 范围裁决）：未来实现时仍必须是 CLI 侧显式
  // --jsonl、有限时长、事件 allowlist，绝不成为常驻 server/MCP。
  { path: ["watch"], summary: "以 --jsonl 输出有限时长的邮件事件流（本轮未实现，无对应 route）", risk: "read", phase: "future" },
] as const;

export function findCommand(argv: readonly string[]): CommandSpec | undefined {
  return [...COMMANDS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((command) => command.path.every((part, index) => argv[index] === part));
}
