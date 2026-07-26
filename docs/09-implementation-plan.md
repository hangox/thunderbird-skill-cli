# 分阶段实施计划

## 设计意图

先建立可验证的协议与安全底座，再逐级开放只读、可逆、草稿和外发能力。每一阶段都必须能独立证明“未授权能力不可用”，不能用未完成的后续 UI 或策略作为当前阶段的安全前提。

## Phase 0：设计与安全骨架（已完成）

交付：

- TypeScript CLI 命令 registry、JSON envelope、错误码。
- 不启动服务的扩展占位。
- Skill 与完整设计文档。
- 未实现命令统一返回 `E_NOT_IMPLEMENTED`。

验收：

```bash
npm install
npm run check
npm test
node dist/cli.js --help
node dist/cli.js --json status
```

预期：类型和测试通过；status 退出码为 3；没有邮件访问。

## Phase 1：Transport、发现与配对（compatibility spike 进行中）

交付：

- 扩展内 `127.0.0.1` server。
- 每实例 descriptor、权限和 stale recovery。
- status/doctor/setup。
- token、timestamp、nonce、Host/Origin 和版本握手。
- Thunderbird UI 中的配对与账号/能力授权页面。

验收：

```bash
npm run test:unit
npm run test:transport
npm run test:security -- --suite discovery,auth,host-origin,replay
thunderbird --json doctor --deep
thunderbird --json status
```

安全门槛：未配对、错误 token、重放 nonce、错误 Host/Origin、世界可读 descriptor 均失败；没有邮件 endpoint。

## Phase 2：只读邮件 MVP

交付：

- accounts/folders/search/recent/message get/open。
- attachments list。
- opaque ref、账号 allowlist、分页、正文截断、HTML 净化。
- Skill 的最小读取与 prompt injection 防护。

验收：

```bash
npm run test:read
npm run test:injection
npm run test:e2e -- --profile read-only
thunderbird --json accounts list
thunderbird --json search --input test/fixtures/search.json
```

安全门槛：扩展 manifest 和策略中没有修改/compose 能力；跨账号 ref、未知字段和超限响应均失败。

## Phase 3：可逆操作与附件保存

交付：

- message mark/move/trash。
- operation status 与 undo token。
- attachments save 的流式传输、敏感路径与 no-clobber。
- 批量阈值和预览。

验收：

```bash
npm run test:reversible
npm run test:attachments
npm run test:e2e -- --profile reversible
npm run test:security -- --suite paths,symlinks,batch-limits,idempotency
```

安全门槛：所有操作可恢复或明确报告部分失败；写操作超时后不自动重复；永久删除不存在。

## Phase 4：草稿能力

交付：

- draft create/update/open。
- identity 校验、正文文件输入、附件摘要。
- Thunderbird 撰写窗口审阅。
- 仍不提供 send endpoint。

验收：

```bash
npm run test:drafts
npm run test:e2e -- --profile drafts
npm run test:security -- --suite identity,input-files,account-scope
```

安全门槛：CLI 不能使用任意 From 地址；正文不进入 argv/日志；所有草稿可在 Thunderbird UI 审阅。

## Phase 5：外发确认

交付：

- send prepare/confirm 两阶段状态机。
- revision、收件人、主题、正文与附件 digest。
- confirmation 过期、一次性使用、operation status 和幂等。
- 本地捕获 SMTP E2E。

验收：

```bash
npm run test:send
npm run test:e2e -- --profile send-capture
npm run test:security -- --suite confirmation,replay,duplicate-send,prompt-injection
```

安全门槛：缺少确认、内容变化、确认过期、跨 client、网络重试均不能重复或错误发送。正式发布前必须人工检查真实 Thunderbird UI 流程。

## Phase 6：日历与可选 watch

交付顺序：

1. calendar list/events 只读。
2. 草稿式事件创建或打开编辑 UI。
3. 邀请外发单独确认。
4. 有限时长、事件 allowlist 的 `watch --jsonl`。

验收：

```bash
npm run test:calendar
npm run test:watch
npm run test:e2e -- --profile calendar
```

递归事件修改、删除整个 series 和邀请更新属于独立高风险设计，不随基础日历读取自动开放。

## Phase 7：发布工程

交付：

- 签名 XPI、CLI 包、Skill 包。
- SBOM、checksum、许可证、可复现构建。
- Thunderbird/macOS/Node 兼容矩阵。
- 安装、升级、回滚和紧急撤销演练。

验收：

```bash
npm ci
npm run check
npm test
npm run build:release
npm run verify:artifact
npm run test:e2e:release
```

## 跨阶段质量门

每阶段合并前必须：

- 新增能力有正向、负向和边界测试。
- 文档、命令 registry、协议 schema 与实现一致。
- 安全日志经过敏感字段扫描。
- 依赖与许可证审查通过。
- 不存在 MCP/JSON-RPC/stdio server 兼容入口。
- 不扩大 manifest 权限，除非该阶段明确需要且 UI 可见。

## 已决事项

- 项目是专用 CLI + Thunderbird 扩展 + 按需 Skill，不注册 MCP。
- MVP transport 为 `127.0.0.1` HTTP/1.1 和每实例 descriptor。
- Thunderbird 账号是唯一邮箱身份源。
- CLI 不保存邮箱凭据或 OAuth token。
- session token 每次扩展启动轮换。
- 默认只读；草稿优先；外发两阶段确认。
- 永久删除不进入早期阶段。

## 假设

- Thunderbird 128 ESR 可提供实现本地服务所需的 Experiment API/XPCOM 能力。
- CLI 与 Thunderbird 运行在同一 OS 用户会话；**该会话被恶意进程控制属于明确 out-of-scope 的已接受残余风险**，Ed25519 + Keychain 不证明调用进程身份。
- Node.js 22 LTS 可作为初始 CLI 基线。
- 项目可以通过测试 profile 和本地 SMTP 捕获器完成 E2E，不需要真实外发。

## 未决问题

| 问题 | 决策时点 | 验证方法 |
|---|---|---|
| MV3 background 与 Experiment API 的最终 manifest 形态 | Phase 1 前 | Thunderbird 128/当前版本最小扩展试验 |
| 使用 Mozilla HTTP server 还是自建最小 server | Phase 1 | 安全审查、许可证、压力和兼容测试 |
| 是否增加 client 公钥签名 | 已决：增加，使用 Ed25519 + `pairingEpoch` 进入 canonical | 已完成；同用户进程隔离**不在**其目标范围内 |
| descriptor 最佳 macOS 目录 | Phase 1 | 终端、签名 App、多个 profile/TCC 矩阵 |
| 附件采用 HTTP 流式 multipart 还是受控临时文件 | Phase 3 | 沙箱可见性、性能和路径攻击测试 |
| Skill 安装采用复制、symlink 或 CLI installer | 发布前 | Claude Code 项目级 Skill 行为验证 |
| 外发正式发布默认是否关闭 | Phase 5 | 安全评审与用户测试 |
| 日历 recurrence 的语义 | Phase 6 | Thunderbird API 行为和跨版本 E2E |

## 威胁模型与残余风险

同一 macOS 用户会话内的恶意进程是**明确 out-of-scope 的已接受残余风险**；Ed25519 + macOS Keychain **不能**证明调用进程身份（同用户进程可读取该私钥），只能证明请求由持有该私钥的实体产生。仍然真实防御的攻击面包括：网页访问本地回环、descriptor 替换、请求重放、被动 token 泄漏与用户误操作；Phase 2 起邮件正文中的任何指令或确认语句永远无效。UI confirm 的真实 GUI 链路因 Dexter 权限不可用而标记为环境未验证。完整表述见根目录 `README.md` 的同名章节。
