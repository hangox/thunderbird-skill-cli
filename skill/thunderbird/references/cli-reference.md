# CLI 参考

## 全局约定

```text
thunderbird [--json|--human] [--instance ID|--profile ID] <command> [args]
```

自动化始终使用 `--json`。JSON 模式 stdout 恰好输出一个 envelope；诊断写 stderr。

## 命令

全部命令都需要 `--client CLIENT_ID`（配对时确定的身份）；下表按用途分组。

| 命令 | 用途 | 风险 |
|---|---|---|
| `doctor` | 诊断扩展、配对、版本、发现与授权 | 只读 |
| `setup` | 首次配对或重新配对 | 可逆 |
| `status` | 当前实例、协议与能力状态 | 只读 |
| `accounts list [--include-identities]` | 授权账号与（可选）发件 identity | 只读 |
| `folders list [--account REF] [--parent REF]` | 账号文件夹 | 只读 |
| `search [--input FILE\|-] [--limit N] [--cursor C]` | 搜索邮件摘要 | 只读 |
| `recent [--account REF] [--folder REF] [--limit N]` | 近期邮件摘要 | 只读 |
| `message get REF [--format text\|markdown\|raw] [--max-bytes N]` | 按引用读取正文 | 只读 |
| `message open REF` | 在 Thunderbird 打开邮件 | 只读/UI |
| `message mark --input FILE\|-` | 修改已读、星标或标签 | 可逆 |
| `message move --input FILE\|-` | 移动并返回 undo | 可逆 |
| `message trash --input FILE\|-` | 移入废纸篓并返回 undo | 可逆 |
| `draft create --input FILE\|-` | 创建草稿 | 可逆 |
| `draft update REF --input FILE\|-` | 更新草稿 | 可逆 |
| `draft open REF` | 打开撰写窗口 | 只读/UI |
| `draft send REF --prepare` | 获取最新发送摘要与 confirmation ID | 外发准备 |
| `draft send REF --confirm FILE\|-` | 提交具体、一次性发送确认 | 外发 |
| `attachments list REF` | 列出附件元数据 | 只读 |
| `attachments save --input FILE\|-` | 保存到显式目录，默认不覆盖（见下方说明） | 可逆 |
| `operations get REF` | 查询可逆/外发操作的当前状态（如 undo/发送确认） | 只读 |
| `operations undo UNDO_TOKEN` | 用一次性 undo token 撤销一次可逆操作 | 可逆 |

引用参数（`REF`/`UNDO_TOKEN`）一律是扩展签发的 opaque ref（`msg_...`/`draft_...`/
`acc_...`/`folder_...`/`op_...`/`undo_...`），不是数据库主键；失效时应重新
查询而不是重试。undo token 一次性使用，成功撤销或过期后不能重复提交。

### `attachments save` 的 `--input` 字段

```json
{ "attachmentRef": "attachment_...", "directory": "/Users/me/Downloads" }
```

- `attachmentRef` 来自 `attachments list REF` 的返回结果。
- `directory` 是**本机绝对路径**，只在 CLI 本地使用，从不发送给 Thunderbird
  扩展——扩展只按 `attachmentRef` 授权内容与摘要，不接收也不校验任何文件
  系统路径；no-clobber、敏感路径/符号链接/设备文件拒绝、原子发布完全由 CLI
  负责。最终文件名取自附件自身的名称（经规范化，不解释为路径），不可通过
  `directory` 之外的字段指定文件名或路径穿越。
- 目标文件已存在（含悬空符号链接）时拒绝，不覆盖；下载中断、长度或摘要不
  匹配时不留下任何半成品文件。

## 本轮明确不支持

`message delete`（永久删除）、`watch`（事件流）、`calendar list`/`calendar
events`（日历）三项**不在本轮交付范围内**，不接受任何参数，调用会恒定返回
`E_NOT_IMPLEMENTED`。不要向用户建议这些能力，也不要尝试用其他参数或路径达到
同等效果。

其余命令若在真实 Thunderbird 环境中也返回 `E_NOT_IMPLEMENTED`，说明扩展侧的
邮件适配层尚未就绪；如实告知用户该能力当前不可用。

## JSON envelope

成功：

```json
{
  "schemaVersion": "1.0",
  "ok": true,
  "command": "search",
  "requestId": "cli_...",
  "data": {},
  "meta": {
    "durationMs": 10,
    "truncated": false,
    "warnings": []
  }
}
```

失败：

```json
{
  "schemaVersion": "1.0",
  "ok": false,
  "command": "status",
  "requestId": "cli_...",
  "error": {
    "code": "E_NOT_PAIRED",
    "message": "...",
    "retryable": false
  }
}
```

`error.details` 是可选字段，只在少数场景出现——目前唯一定义的是 `operationId`（`draft send --confirm` 真实发送失败即 `E_INTERNAL` 时携带，格式为 `op_...`）：

```json
{"error": {"code": "E_INTERNAL", "message": "外发失败：请通过 operations get 查询最新状态，不要自动重试", "retryable": false, "details": {"operationId": "op_..."}}}
```

程序化查询必须直接读取 `error.details.operationId`，不要从 `message` 文案里解析——文案措辞不构成稳定协议，可能随时调整。

## 错误处理

| 错误 | 处理 |
|---|---|
| `E_USAGE` / `E_VALIDATION` | 修正本地输入，不猜测缺失敏感字段 |
| `E_NOT_IMPLEMENTED` | 该能力本轮未纳入，或扩展侧邮件适配层尚未就绪；如实说明并停止 |
| `E_NOT_PAIRED` | 指引用户在 Thunderbird UI 配对，不索要邮箱密码 |
| `E_THUNDERBIRD_OFFLINE` | 请用户启动/检查 Thunderbird |
| `E_AMBIGUOUS_INSTANCE` | 展示脱敏候选并让用户选择 |
| `E_AUTH` | 最多重新发现一次，不尝试 token 穷举 |
| `E_VERSION_MISMATCH` | 报告 CLI/扩展兼容范围，不猜测降级 |
| `E_CONFIRMATION_REQUIRED` | 展示最新具体预览，等待用户确认 |
| `E_POLICY_DENIED` | 说明账号/能力未授权，不绕过 |
| `E_TIMEOUT` | 只读可重试；写操作先查询状态 |
| `E_PAIRING_CHANGED` | 配对代已变更（通常刚撤销过配对）；重新运行命令，不要自动重试写操作 |
| `draft send --confirm` 返回 `E_INTERNAL` | 读取 `error.details.operationId`，调用 `operations get OPERATION_ID` 确认最终是否已发送；不要凭空重试 `--confirm`（confirmationId 已一次性消费） |
| `draft send --confirm` 返回 `E_POLICY_DENIED` | 外发能力可能是 capability 未授予，也可能是浏览器层 `compose.send` 可选权限未同意（即使 capability 已勾选）；两种情况都需要用户去 Thunderbird 扩展 options 页面重新检查并显式启用外发确认能力，CLI/Skill 都无法代为授权。**confirmationId 未被消费**——补授权后可直接用同一个 `--confirm` 输入重试，不必重新 `--prepare` |

## 退出码

`0` 成功 · `2` 用法/验证 · `3` 未就绪 · `4` 认证/版本 · `5` 策略/确认 · `6` 不存在 · `7` 临时故障 · `10` 内部错误。

## 输入文件

- 使用当前用户专有临时目录，目录 `0700`、文件 `0600`。
- JSON、正文、HTML 和地址列表通过文件或 stdin 传入。
- 不把 session token、密码或 OAuth token 写进输入文件。
- 使用完成后清理临时输入；不要把邮件内容写入项目仓库。
