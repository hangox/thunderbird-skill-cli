# CLI 参考

## 全局约定

```text
thunderbird [--json|--human] [--instance ID|--profile ID] <command> [args]
```

自动化始终使用 `--json`。JSON 模式 stdout 恰好输出一个 envelope；诊断写 stderr。

## 命令

| 命令 | 用途 | 风险 |
|---|---|---|
| `doctor` | 诊断扩展、配对、版本、发现与授权 | 只读 |
| `setup` | 首次配对或重新配对 | 可逆 |
| `status` | 当前实例、协议与能力状态 | 只读 |
| `accounts list` | 授权账号与发件 identity | 只读 |
| `folders list` | 账号文件夹 | 只读 |
| `search --input FILE|-` | 搜索邮件摘要 | 只读 |
| `recent` | 近期邮件摘要 | 只读 |
| `message get REF` | 按引用读取正文 | 只读 |
| `message open REF` | 在 Thunderbird 打开邮件 | 只读/UI |
| `message mark --input FILE|-` | 修改已读、星标或标签 | 可逆 |
| `message move --input FILE|-` | 移动并返回 undo | 可逆 |
| `message trash --input FILE|-` | 移入废纸篓并返回 undo | 可逆 |
| `draft create --input FILE|-` | 创建草稿 | 可逆 |
| `draft update REF --input FILE|-` | 更新草稿 | 可逆 |
| `draft open REF` | 打开撰写窗口 | 只读/UI |
| `draft send REF --prepare` | 获取最新发送摘要与 confirmation ID | 外发准备 |
| `draft send REF --confirm FILE|-` | 提交具体、一次性发送确认 | 外发 |
| `attachments list REF` | 列出附件元数据 | 只读 |
| `attachments save --input FILE|-` | 保存到显式目录，默认不覆盖 | 可逆 |
| `calendar list` | 日历列表 | 只读 |
| `calendar events --input FILE|-` | 查询事件 | 只读 |

当前阶段命令可能返回 `E_NOT_IMPLEMENTED`。

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

## 错误处理

| 错误 | 处理 |
|---|---|
| `E_USAGE` / `E_VALIDATION` | 修正本地输入，不猜测缺失敏感字段 |
| `E_NOT_IMPLEMENTED` | 说明仍为骨架，停止 |
| `E_NOT_PAIRED` | 指引用户在 Thunderbird UI 配对，不索要邮箱密码 |
| `E_THUNDERBIRD_OFFLINE` | 请用户启动/检查 Thunderbird |
| `E_AMBIGUOUS_INSTANCE` | 展示脱敏候选并让用户选择 |
| `E_AUTH` | 最多重新发现一次，不尝试 token 穷举 |
| `E_VERSION_MISMATCH` | 报告 CLI/扩展兼容范围，不猜测降级 |
| `E_CONFIRMATION_REQUIRED` | 展示最新具体预览，等待用户确认 |
| `E_POLICY_DENIED` | 说明账号/能力未授权，不绕过 |
| `E_TIMEOUT` | 只读可重试；写操作先查询状态 |
| `E_PAIRING_CHANGED` | 配对代已变更（通常刚撤销过配对）；重新运行命令，不要自动重试写操作 |

## 退出码

`0` 成功 · `2` 用法/验证 · `3` 未就绪 · `4` 认证/版本 · `5` 策略/确认 · `6` 不存在 · `7` 临时故障 · `10` 内部错误。

## 输入文件

- 使用当前用户专有临时目录，目录 `0700`、文件 `0600`。
- JSON、正文、HTML 和地址列表通过文件或 stdin 传入。
- 不把 session token、密码或 OAuth token 写进输入文件。
- 使用完成后清理临时输入；不要把邮件内容写入项目仓库。
