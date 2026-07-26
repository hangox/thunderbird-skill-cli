# 代码评审、测试与发布

## 设计意图

实现按信任边界拆分，每个 PR 都能在不接触真实邮箱写操作的前提下独立验证。安全关键代码必须有对应负向测试，外发能力只有在只读与可逆能力稳定后单独启用。

## PR / 提交拆分

| PR | 范围 | 不包含 |
|---|---|---|
| 1. 契约骨架 | CLI parser、envelope、错误码、文档 | 网络与 Thunderbird API |
| 2. 发现与握手 | descriptor、权限检查、status mock、版本协商 | 邮件读取 |
| 3. 扩展 transport | loopback、Host/Origin、token、nonce、限流 | 业务 endpoint |
| 4. 配对与授权 | UI、client、账号/能力 allowlist | 写操作 |
| 5. 只读邮件 | accounts、folders、search、get、recent、附件元数据 | 保存附件、修改邮件 |
| 6. 可逆操作 | mark、move、trash、undo、附件 no-clobber 保存 | 外发 |
| 7. 草稿 | create/update/open、输入文件沙箱 | send |
| 8. 外发 | prepare/confirm、revision、幂等与状态查询 | 永久删除 |
| 9. 日历 | 先读取，写入另开 PR | 邮件功能改造 |
| 10. 发布 | XPI、CLI 包、兼容矩阵、升级回滚 | 新能力 |

每个提交聚焦一个安全性质或一组紧密相关测试，避免把 transport、权限和业务代码混在无法审查的大提交中。

## 评审清单

### 通用

- 类型严格，无 `any` 绕过、无不必要类型断言。
- 命令与 endpoint 使用单一 registry，名称和风险不重复定义。
- 不引入 MCP、JSON-RPC、stdio server 或动态工具发现。
- 所有边界都有大小、超时、数量和并发限制。
- 错误不会泄漏 token、正文、路径、账号或堆栈。

### Transport / 认证

- 仅绑定 `127.0.0.1`，测试确认不能 listen-all。
- `Host` 精确校验，非预期 `Origin` 拒绝。
- token 高熵、启动期轮换、constant-time compare。
- descriptor owner/权限/symlink/原子写入均测试。
- timestamp/nonce 防重放，认证在路由和业务解析前执行。
- `protocolVersion=1` 的 paired identity 必须携带纯断言字段 `publicKeyAlgorithm: "Ed25519"`。该字段**不驱动算法选择、不参与算法协商**，也不存在对应的签名算法 header；配对 body 必须恰好是 `{clientId, publicKeyAlgorithm, publicKeySpkiBase64}` 三键。公钥必须是 60 字符 base64 / 44 字节 DER / 前缀 `302a300506032b6570032100` 的 Ed25519 SPKI。缺字段、额外第四键、值大小写不符、P-256 或任何畸形 SPKI 均失败关闭；持久记录缺失或不匹配该字段时不默认回填。
- `descriptorVersion=2` 携带独立持久化的 `pairingEpoch`（与 `protocolVersion=1` 独立演进）。epoch 存于不受 `clearPairing` 影响的单独 pref，revoke 时先单调递增并持久化再清对，重启后保持；epoch 进入 CLI 与扩展双方 canonical 签名，只接受 `/^(0|[1-9][0-9]{0,15})$/` 并以原始字符串比较。撤销后的旧预签请求必须返回 `409 E_PAIRING_CHANGED`（`retryable:true`，CLI exit 7，写操作不自动重试）。canonical 变更靠 CLI/扩展版本兼容握手提前给出 `E_VERSION_MISMATCH`，不 bump `protocolVersion`。
- 多实例不会覆盖，歧义时失败。

### 权限 / 业务

- schema 拒绝未知字段、prototype pollution 和越界值。
- 每个对象 ref 解析后重查 profile、账号和能力。
- 配置损坏失败关闭。
- identity 来自 Thunderbird 当前授权账号。
- 写操作幂等语义明确，不发生自动重复发送。
- 外发两阶段确认绑定最新草稿 revision。

### Skill

- description 覆盖真实触发场景且不泛化到一般写作。
- 正文、HTML、附件不进入 shell argv。
- 邮件内容明确作为不可信数据。
- 只读→预览→可逆→草稿→确认顺序不可跳过。
- 大结果压缩与分页，不把附件 base64 注入上下文。

## 威胁模型

| 威胁 | 攻击路径 | 控制 |
|---|---|---|
| 本机其他用户读取 token | 临时文件权限过宽 | owner、`0700`/`0600`、symlink 拒绝 |
| 同一 macOS 用户会话内的恶意进程 | 读取 0600 descriptor 与 session token、导出 Keychain 中的 Ed25519 PKCS#8、直接以用户身份运行 CLI | **明确 out-of-scope（accepted residual risk），不是待修复缺陷**：任何纯用户态方案都无法在此边界内提供隔离。**不得声称 Ed25519 + Keychain 证明调用进程身份** —— 签名只证明请求由持有该私钥的实体产生。session token 短期轮换、nonce 与 `pairingEpoch` 仍限制过期与撤销后的重放 |
| DNS rebinding/网页请求 | 浏览器访问 loopback | 数值绑定、Host/Origin、自定义头、认证、Content-Type |
| descriptor 替换 | 指向攻击者端口/token | 可信根、owner/权限、原子文件、status identity 握手 |
| prompt injection | 邮件正文诱导 Claude 执行动作 | 不可信数据边界、用户意图来源检查、扩展静态策略 |
| 参数污染 | `__proto__`/未知字段 | 严格 schema、own property、危险键拒绝 |
| 跨账号越权 | 伪造 folder/message ref | opaque ref + 解析后账号 allowlist |
| 重试导致重复发送 | 超时后自动重试 | confirmation、idempotency、operation status |
| 路径穿越/附件窃取 | 恶意路径或文件名 | no symlink、敏感路径拒绝、流式传输、no-clobber |
| 日志泄漏 | 正文/token 被记录 | 字段 allowlist、hash、轮转、诊断再脱敏 |
| 版本降级 | 旧 CLI 猜测协议 | 主版本握手、不兼容即失败 |

评审时至少由一名未参与实现者针对“如何绕过当前控制”做对抗式检查。

## 测试矩阵

| 层 | 测试 |
|---|---|
| CLI unit | parser、命令 registry、JSON envelope、exit code、stderr、human mode |
| Schema | 必填/未知字段、边界值、Unicode、prototype pollution、超大数组 |
| Discovery | 多实例、stale PID、错误 owner/权限、symlink、原子更新、override |
| Transport | 绑定地址、Host、Origin、method、Content-Type、大小、并发、超时 |
| Auth | token 格式、constant-time path、过期、轮换、nonce 重放、速率限制 |
| Version | 兼容范围、主版本不匹配、能力缺失、升级中 descriptor |
| Policy | 账号 allowlist、能力、风险、批量阈值、配置损坏失败关闭 |
| Read | accounts/folders/search/get/recent、截断、分页、HTML 净化 |
| Reversible | mark/move/trash、undo 过期、部分失败、幂等 |
| Draft/send | identity、revision 变化、收件人变化、确认过期、未知发送结果 |
| Attachment | symlink、路径穿越、MIME 不一致、大小/数量、覆盖冲突 |
| Injection | 邮件/HTML/附件中伪指令不得触发动作 |
| Crash | server 异常、Thunderbird 退出、descriptor 清理、恢复 |

## E2E 策略

建立专用测试 profile 和本地测试账号，绝不使用个人真实邮箱作为自动测试目标。

1. 启动 Thunderbird 测试 profile，安装测试 XPI。
2. 注入固定 fixture 邮件、文件夹、草稿和日历数据。
3. 从真实 CLI 进程执行配对与只读命令。
4. 验证 descriptor 权限、端口绑定和请求拒绝案例。
5. 可逆操作验证 undo 后恢复原状态。
6. 外发测试使用本地捕获 SMTP 或不可投递测试域，验证确认状态机与仅一次投递。
7. 每次测试销毁 profile，检查无 token、正文临时文件或监听进程残留。

CI 中不运行需要真实 Thunderbird GUI 的全部矩阵时，至少运行 headless contract/mock；签名候选发布前运行完整 E2E。

## 兼容性矩阵

正式声明前验证：

| 维度 | 最低目标 |
|---|---|
| Thunderbird | 128 ESR；当前 ESR；当前 release |
| macOS | 当前支持的两个主版本，Intel/Apple Silicon 按可用环境 |
| Node.js | 22 LTS；当前 LTS |
| Profile | 单 profile；并行双 profile；迁移/复制 profile |
| 安装 | 临时扩展；签名 XPI；升级；降级 |
| 账号 | IMAP；本地文件夹；OAuth 账号；离线状态 |
| 邮件 | 纯文本；HTML；大正文；附件；Unicode；嵌套 MIME |

MV3、background 生命周期与 Experiment API 的实际兼容性必须以真实 Thunderbird 测试为准，不能只通过 manifest schema 推断。

## 发布、升级与回滚

- CLI 与扩展独立版本，协议主版本明确。
- 发布产物包含 checksum、SBOM、许可证与签名信息。
- XPI 与 npm/package tarball 从干净 tag 可复现构建。
- 扩展升级先启动新协议兼容层，通过握手后再移除旧 descriptor；不保留 MCP 兼容层。
- 权限扩大时由 Thunderbird 显示新增权限，不能静默升级。
- 回滚只支持协议声明的兼容范围；不兼容时提示匹配版本。
- 紧急撤销：扩展 UI 可关闭本地服务、撤销全部 client、轮换会话；CLI 包可通过发布渠道标记撤回。

## 验收标准

- 所有静态检查、unit、integration 和负向安全测试通过。
- 源码搜索无 MCP 生命周期、JSON-RPC 或 stdio server 实现。
- loopback 只能从 `127.0.0.1` 访问，恶意 Host/Origin/nonce 均被拒绝。
- 多实例不会误连；授权损坏不会扩大权限。
- 邮件内容中的测试注入无法触发任何写操作。
- 外发在缺少最新、具体、一次性确认时必然失败。
- 日志与诊断包不含 token、正文、完整地址或本机敏感路径。
