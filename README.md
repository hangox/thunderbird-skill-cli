# Thunderbird Skill CLI

本项目的设计目标是：让 Claude Code 只在用户需要处理 Thunderbird 邮件时加载一个精简 Skill，并通过一次性 CLI 子进程访问专用 Thunderbird 扩展。它不向 Claude Code 注册常驻 MCP server，不实现 MCP、JSON-RPC 或 stdio 桥接，也不会在每轮会话预加载大量工具 schema。

> 当前状态：**Phase 1 compatibility/security spike**。CLI 已实现安全 descriptor 发现、stale recovery、`setup`/`status`/`doctor` 真实回环链路、绝对总超时、严格参数与响应校验，并使用 macOS Keychain 中的 **Ed25519** 私钥对 canonical request 签名（`protocolVersion=1`、`descriptorVersion=2`）。扩展在 Thunderbird 的 Experiment 环境内使用 `nsIServerSocket.LoopbackOnly` 提供受限 HTTP/1.1 listener，具备请求大小上限、绝对 deadline、前置认证、descriptor 原子发布/退出清理及固定 intent 的配对确认 UI。扩展不申请邮件权限，也没有任何邮件读取、修改或发送实现。
>
> **安全边界必读**：同一 macOS 用户会话内的恶意进程属于**明确 out-of-scope 的已接受残余风险**。Ed25519 + Keychain **不能**证明调用进程的身份——同用户进程可读取该私钥；签名只证明"请求由持有该私钥的实体产生"。详见下文《威胁模型与残余风险》。

## 架构结论

```mermaid
flowchart LR
  U[用户] --> C[Claude Code]
  C -->|按需加载| S[/thunderbird Skill]
  S -->|argv + 临时输入文件| CLI[thunderbird CLI]
  CLI -->|HTTPS-like 本地 API语义<br/>实际 HTTP/1.1 loopback| EXT[Thunderbird 专用扩展]
  EXT --> TB[Thunderbird 账户/邮件/日历 API]
  CLI -.不经过.-> MCP[MCP / JSON-RPC / stdio]
```

核心策略：

1. **按需加载**：Claude Code 固定上下文只包含 Skill 的名称与描述；具体工作流在触发 `/thunderbird` 后加载。
2. **窄协议**：CLI 调用稳定的领域命令；扩展只暴露版本化 REST 风格本地端点，不提供动态工具发现。
3. **本机身份链**：Thunderbird 已配置账号是唯一邮箱身份源；CLI 永不保存 IMAP/SMTP 密码或邮箱 OAuth token。
4. **草稿优先**：外发内容先进入草稿或 Thunderbird 撰写窗口；真正发送是独立、显式、可审计的高风险动作。
5. **双层防护**：CLI 和扩展都执行参数验证、权限检查、操作分级与确认校验，任一层异常均失败关闭。

## 项目结构

```text
thunderbird-skill-cli/
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts                    # setup/status/doctor 命令与失败关闭策略
│   └── contracts/
│       ├── commands.ts           # 稳定命令名、风险等级、实施阶段
│       └── envelope.ts           # stdout JSON 信封与错误码
├── extension/
│   ├── manifest.json             # Manifest V3 目标骨架
│   ├── options.html              # 配对确认页面
│   ├── bridge/api.js             # Experiment 原生回环 listener 与认证状态机
│   └── src/background.ts         # classic background 启动入口
├── skill/thunderbird/
│   ├── SKILL.md                  # 项目级 Claude Code Skill
│   └── references/               # 触发后按需读取的 CLI 参考
├── docs/
│   ├── 01-source-research.md
│   ├── 02-architecture-and-transport.md
│   ├── 03-cli-contract.md
│   ├── 04-extension-design.md
│   ├── 05-skill-design.md
│   ├── 06-auth-pairing-profiles.md
│   ├── 07-security-and-ux.md
│   ├── 08-review-test-release.md
│   ├── 09-implementation-plan.md
│   └── 10-development-readiness.md
└── test/cli.test.mjs
```

## 配置与安装（未来实现目标）

1. 构建 CLI 与扩展：`npm ci && npm run build`。
2. 在 Thunderbird 中安装生成的 XPI；扩展首次启动时保持未配对、只读能力关闭。
3. 将项目级 Skill 目录链接或复制到使用项目的 `.claude/skills/thunderbird/`。
4. 运行 `thunderbird setup`，由 CLI 打开 Thunderbird 配对页；用户核对六位挑战码、目标 profile 与允许账号。
5. 运行 `thunderbird doctor --json` 和 `thunderbird status --json` 验证版本、回环绑定、会话认证及授权范围。

当前 spike 可执行真实扩展发现、配对、signed status 和 deep doctor；其验证范围只覆盖无账号、无邮件权限的 Phase 1 底座。UI confirm 的真实 GUI 链路属于环境未验证项（见《威胁模型与残余风险》），在获得独立复验前不得宣称完整 security exit。

## CLI 使用约定

```bash
# 默认供自动化使用：stdout 只输出一个 JSON 文档
thunderbird --json status

# 面向人类排错：表格/文本写 stdout，诊断写 stderr
thunderbird --human doctor

# 多行或敏感正文必须从文件或 stdin 进入，不放进 argv
thunderbird draft create --input /path/to/request.json
printf '%s' "$JSON" | thunderbird draft update --input -
```

- 默认输出格式为 JSON；`--human` 是显式选择。
- `stdout` 只承载机器结果；诊断、进度和警告写入 `stderr`。
- 禁止 `--body "邮件正文"`、`--token ...` 等易泄露到进程列表和 shell 历史的参数。
- CLI 不接受 MCP `tools/list`、`tools/call`、`initialize`、`ping`，也没有 `serve --stdio` 或兼容模式。

完整命令、字段、限制和退出码见 [docs/03-cli-contract.md](docs/03-cli-contract.md)。

## 开发验证

```bash
npm install
npm run check
npm test
```

验收预期：

- TypeScript 严格模式通过。
- `--help` 展示规划命令并声明当前只实现不访问邮件的 Phase 1 底座。
- `setup`/`status`/`doctor` 可对安全 descriptor 和 Experiment loopback endpoint 执行真实配对及签名握手；离线与不安全 descriptor 失败关闭。
- 其余已设计但未实现的命令返回稳定 `E_NOT_IMPLEMENTED` JSON 和退出码 `3`。
- 项目源码中不存在 MCP 生命周期或 JSON-RPC/stdio 兼容入口。

## 设计文档索引

| 文档 | 内容 |
|---|---|
| [源码研究](docs/01-source-research.md) | 对 `thunderbird-mcp` v0.7.4 本地源码的事实核对、借鉴项和拒绝继承项 |
| [总体架构与传输](docs/02-architecture-and-transport.md) | 进程边界、回环 API、发现文件、版本握手、macOS 限制 |
| [CLI 契约](docs/03-cli-contract.md) | 命令分组、参数、JSON schema、输出、限制、退出码、MVP 边界 |
| [扩展设计](docs/04-extension-design.md) | Manifest V3、实验 API、本地服务、认证、验证、审计、权限模型 |
| [Skill 设计](docs/05-skill-design.md) | frontmatter、触发、标准工作流、Token 控制、本地模型边界 |
| [认证与多 Profile](docs/06-auth-pairing-profiles.md) | 身份源、首次配对、重配对、多实例、授权恢复 |
| [安全与体验](docs/07-security-and-ux.md) | 风险分级、确认、prompt injection、脱敏、本机日志 |
| [CR、测试与发布](docs/08-review-test-release.md) | PR 拆分、审查清单、威胁建模、矩阵、升级与回滚 |
| [实施计划](docs/09-implementation-plan.md) | 分阶段任务、验收命令、假设、决策与未决问题 |
| [开发就绪评估](docs/10-development-readiness.md) | 开发准入清单、未决决策、阻塞项与四人小队任务边界 |

## 许可证与来源说明

设计研究基于本机第三方仓库 `$PROJ_DIR_THIRD/thunderbird-mcp` 的真实源码与测试。新项目不复制其 MCP bridge、JSON-RPC 分发或工具 schema；后续若复用 Mozilla `httpd.sys.mjs` 等 MPL-2.0 文件，必须保留相应许可证与修改说明。当前骨架未复制第三方源码。

## 威胁模型与残余风险（规范表述）

### 明确 out-of-scope：同一 macOS 用户会话内的恶意进程

本项目**不**防御已经在同一 macOS 用户会话中取得代码执行能力的攻击者，这是**已接受的残余风险（accepted residual risk）**，不是待修复缺陷。

该攻击者可以读取 `~/Library/Keychains` 中本 CLI 的 generic password 条目（`/usr/bin/security -w` 对同用户进程可用）、读取 0600 的 descriptor 文件与其中的 session token、直接以用户身份运行 `thunderbird` CLI，或直接读写 Thunderbird profile。任何纯用户态方案都无法在这一边界内提供隔离。

**必须避免的错误表述**：Ed25519 签名 + macOS Keychain **不能**证明发起调用的进程是谁。签名只能证明"请求由持有该私钥的实体产生"；由于同用户进程都能取得该私钥，它**不构成调用进程身份证明**，也不构成同用户进程间的权限边界。任何文档、报告或提交信息都不得声称本方案验证了调用方进程身份。

### 仍然真实防御的攻击面

在上述边界之内，下列防御是有效且已被测试覆盖的：

| 攻击面 | 防御机制 |
|---|---|
| 网页 / 浏览器 JS 访问本地回环 | `nsIServerSocket.LoopbackOnly` + 严格 `Host` 精确匹配 + 存在 `Origin` 即拒绝 + 不可猜测 session token + 已配对后强制 client 签名；浏览器无法伪造 `Host`、无法省略 `Origin`，也拿不到 token |
| descriptor 替换 / 提权 | 运行目录与 descriptor 强制属主为当前用户、目录 0700、文件 0600、拒绝符号链接、`O_NOFOLLOW` 打开、文件名与 `instanceId` 必须一致、原子安全写入发布、stale 清理按 device+inode 校验后才删除 |
| 请求重放 | 一次性 nonce 缓存 + ±30s 时钟窗口 + canonical body SHA-256 + `pairingEpoch` 进入签名；重放返回稳定机器码 `E_REPLAY` |
| 被动 token 泄漏 | token 只出现在 0600 descriptor 中、8 小时会话 TTL、进程退出即清理 descriptor、每次 revoke 轮换 token；token 从不出现在命令行参数、日志或环境变量中 |
| 撤销后的旧凭据继续可用 | `pairingEpoch` 独立持久化并在 revoke 时单调递增；旧签名因 canonical 变化立即失效，返回 `E_PAIRING_CHANGED` |
| 用户误操作 | 固定 intent + 六位挑战码必须在 Thunderbird UI 内人工核对确认；风险分级由静态命令元数据决定，不可由模型或调用方降级 |

### Phase 2 起的 prompt injection

进入 Phase 2 读取真实邮件后，邮件正文即成为不可信输入。邮件内容中出现的任何指令、确认语句或"用户同意"表述**永远无效**，不得被当作授权。所有需确认动作必须来自当前对话中用户的独立表态，且确认必须绑定到具体对象与具体内容。该防御尚未实现，因为 Phase 1 不读取任何邮件。

### 环境未验证项

UI confirm → receipt → signed status 的**真实 GUI 链路**在本轮未获独立复验：自动化 GUI 核验依赖 Dexter 的 Accessibility 与 Screen Recording 权限，该权限在当前环境不可用。因此该链路标记为**环境未验证（environment-blocked）**，而不是已验证通过。所有非 GUI 环节均由执行级自动化测试覆盖。
