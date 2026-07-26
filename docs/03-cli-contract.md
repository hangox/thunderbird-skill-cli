# CLI 契约

## 设计意图

CLI 是面向自动化的稳定领域接口，不是通用 RPC 客户端。命令名长期稳定，默认输出单个 JSON 文档；所有敏感或多行内容通过文件或 stdin 输入，避免 shell 历史与进程列表泄露。

## 全局语法

```text
thunderbird [--json|--human] [--instance ID|--profile ID] [--timeout MS] <command> [args]
```

全局规则：

- 默认等价于 `--json`。
- `--human` 只用于人工排错，不能由 Skill 解析。
- `--instance` 和 `--profile` 用于多实例消歧，不能同时指定冲突目标。
- `--timeout` 只能在命令允许范围内缩短或有限增加，不能关闭超时。
- 不接受 `--token`、`--password`、`--oauth-token`、`--body`、`--html`。
- `--input -` 表示从 stdin 读取一个 JSON 文档；否则只接受绝对路径或经安全解析的路径。

## 稳定命令树

| 命令 | 核心参数 | 风险 | 阶段 |
|---|---|---|---|
| `doctor` | `--deep` | 只读 | MVP |
| `setup` | `--reconfigure` | 可逆 | MVP |
| `status` | 无 | 只读 | MVP |
| `accounts list` | `--include-identities` | 只读 | MVP |
| `folders list` | `--account ID`、`--parent REF` | 只读 | MVP |
| `search` | `--input FILE\|-`、`--limit`、`--cursor` | 只读 | MVP |
| `recent` | `--account ID`、`--folder REF`、`--limit` | 只读 | MVP |
| `message get` | `MESSAGE_REF`、`--format text\|markdown\|raw`、`--max-bytes` | 只读 | MVP |
| `message open` | `MESSAGE_REF` | 只读/UI | MVP |
| `message mark` | `--input FILE\|-` | 可逆 | Phase 2 |
| `message move` | `--input FILE\|-` | 可逆 | Phase 2 |
| `message trash` | `--input FILE\|-` | 可逆 | Phase 2 |
| `message delete` | `--input FILE\|-`、强确认 | 破坏性 | Future |
| `draft create` | `--input FILE\|-` | 可逆 | Phase 2 |
| `draft update` | `DRAFT_REF --input FILE\|-` | 可逆 | Phase 2 |
| `draft open` | `DRAFT_REF` | 只读/UI | Phase 2 |
| `draft send` | `DRAFT_REF --confirm FILE\|-` | 外发 | Phase 3 |
| `attachments list` | `MESSAGE_REF` | 只读 | MVP |
| `attachments save` | `--input FILE\|-` | 可逆/文件写入 | Phase 2 |
| `calendar list` | 无 | 只读 | Phase 3 |
| `calendar events` | `--input FILE\|-` | 只读 | Phase 3 |
| `watch` | `--events ... --duration SEC` | 只读/长运行 | Future |

命令 registry 是名称、风险和阶段的单一来源。新增或重命名命令属于契约变更，必须经过兼容性审查。

## 输入示例

### 搜索

```json
{
  "query": "invoice",
  "accountIds": ["acc_..."],
  "folderRefs": ["folder_..."],
  "from": ["billing@example.com"],
  "after": "2026-07-01T00:00:00Z",
  "before": "2026-08-01T00:00:00Z",
  "hasAttachments": true,
  "includeBody": false
}
```

`includeBody` 在 MVP 必须保持 `false`；正文读取使用独立 `message get`，避免搜索结果膨胀。

### 创建草稿

```json
{
  "identityId": "identity_...",
  "to": [{"address": "person@example.com", "name": "Person"}],
  "cc": [],
  "bcc": [],
  "subject": "主题",
  "body": {
    "format": "text",
    "file": "/private/tmp/thunderbird-input/body.txt"
  },
  "attachments": [
    {"file": "/Users/me/Documents/report.pdf", "displayName": "report.pdf"}
  ],
  "clientRequestId": "draft-create-unique-id"
}
```

正文不得内联到 argv。完整实现可允许小正文内联 JSON，但 Skill 仍必须优先使用 `body.file` 或 stdin，以统一泄露面。

### 发送确认

发送采用双调用：

1. `draft send DRAFT_REF --prepare` 返回不可伪造的短期 `confirmationId`、内容摘要和收件人清单。
2. 用户明确确认后，通过 `--confirm FILE|-` 提交：

```json
{
  "confirmationId": "confirm_...",
  "draftRevision": "sha256:...",
  "recipientDigest": "sha256:...",
  "subjectDigest": "sha256:...",
  "confirmedAt": "2026-07-24T12:00:00Z"
}
```

扩展再次读取草稿并比对 revision 与摘要。草稿在预览后发生任何变化，确认立即失效。禁止 `--yes`、`--force`、`skipReview` 绕过。

## stdout JSON schema

成功：

```json
{
  "schemaVersion": "1.0",
  "ok": true,
  "command": "search",
  "requestId": "cli_...",
  "data": {},
  "meta": {
    "durationMs": 42,
    "truncated": false,
    "warnings": [],
    "nextCursor": "cursor_..."
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
    "message": "Thunderbird 扩展尚未与此 CLI 配对",
    "retryable": false,
    "details": {"action": "run-setup"}
  }
}
```

规则：

- JSON 模式 stdout 恰好输出一个 UTF-8 JSON 文档和换行。
- 警告仍放 `meta.warnings`；诊断和进度只写 stderr。
- 不在错误中返回 token、descriptor 路径、正文、完整收件人或账号地址。
- cursor 是不透明、短期、绑定 query 与 instance 的值。
- `requestId` 可用于本机审计关联，但不包含 PID、邮箱或路径。

## stderr 与 human mode

| 模式 | stdout | stderr |
|---|---|---|
| JSON 成功 | JSON envelope | 可选短诊断，默认安静 |
| JSON 失败 | JSON error envelope | 连接/调试摘要，不含敏感数据 |
| Human 成功 | 表格或文本 | 警告与进度 |
| Human 失败 | 可为空 | 可操作的中文错误 |

Skill 永远使用 JSON 模式并直接执行 argv 数组，不构造 `sh -c` 字符串。

## 退出码

| 退出码 | 含义 | 典型错误码 |
|---:|---|---|
| 0 | 成功 | 无 |
| 2 | 命令或参数错误 | `E_USAGE`、`E_VALIDATION` |
| 3 | 功能未就绪 | `E_NOT_IMPLEMENTED`、`E_NOT_PAIRED`、`E_THUNDERBIRD_OFFLINE`、`E_PAIRING_PENDING`、`E_ALREADY_PAIRED` |
| 4 | 本地认证/版本失败 | `E_AUTH`、`E_REPLAY`、`E_VERSION_MISMATCH` |
| 5 | 策略拒绝或需确认 | `E_CONFIRMATION_REQUIRED`、`E_POLICY_DENIED` |
| 6 | 对象不存在或已失效 | `E_NOT_FOUND` |
| 7 | 临时故障 | `E_TIMEOUT`、`E_PAIRING_CHANGED`、可重试连接错误 |
| 10 | 未分类内部错误 | `E_INTERNAL` |

`E_PAIRING_CHANGED` 表示扩展的 `pairingEpoch` 已推进（通常是刚刚在 UI 里撤销过配对）。它的 `retryable` 为 `true`，但这只表示"重新发现 descriptor 后再发一次是安全的"；**CLI 绝不自动重试写操作**，必须由调用方重新执行命令。

## 数据压缩与分页

搜索/近期邮件默认字段：

- `messageRef`
- `threadRef`
- `accountRef`
- `folderRef`
- `from` 的脱敏展示值
- `subject`
- `receivedAt`
- `flags`
- `attachmentCount`
- 最多 240 字符纯文本 preview

默认不返回完整 headers、HTML、raw MIME、附件字节或引用历史。`message get` 超限时：

```json
{
  "content": "截断文本…",
  "contentFormat": "text",
  "originalBytes": 845000,
  "returnedBytes": 65536,
  "truncated": true,
  "nextCursor": "body_cursor_..."
}
```

HTML 默认经过净化后转为纯文本或 Markdown；`raw` 仅限明确用户请求、只读流程和硬大小限制。

## 对象引用

CLI 不暴露可猜测的数据库主键或原始 folder URI。扩展生成带实例作用域的 opaque ref，例如 `msg_...`、`folder_...`、`draft_...`。ref 必须绑定 profile/instance；跨实例使用返回 `E_NOT_FOUND`，不泄漏对象是否存在。

## 写操作与撤销

可逆操作成功时返回：

```json
{
  "operationId": "op_...",
  "affected": ["msg_..."],
  "undo": {
    "token": "undo_...",
    "expiresAt": "2026-07-24T12:10:00Z",
    "summary": "将 1 封邮件移回原文件夹"
  }
}
```

undo token 只能恢复该操作，短期有效、一次性使用，并绑定 instance 与调用者配对。

## `watch` 约束

未来 `watch` 是唯一允许 JSONL 的命令，必须显式声明 `--jsonl`，默认最长 15 分钟并有心跳与事件类型 allowlist。它不是 server 模式，也不接受 stdin RPC。

## 当前骨架边界

现有 CLI 已实现 Phase 1 compatibility spike 的全局安全参数解析、descriptor 发现、`status` 与 `doctor` 回环握手；其余命令仍返回 `E_NOT_IMPLEMENTED`。配对、附件和邮箱功能尚未实现，真实扩展监听也未在隔离 Thunderbird profile 中验证。
