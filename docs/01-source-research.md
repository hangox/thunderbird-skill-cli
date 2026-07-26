# 第三方源码研究

## 研究意图

本项目借鉴 `thunderbird-mcp` 已验证的 Thunderbird 特权扩展、本地发现和失败关闭经验，但切断 MCP 层。研究目标不是改造或兼容该项目，而是确认哪些本机通信与安全机制值得重新设计为专用 CLI 协议。

## 研究范围与事实基线

本机研究对象为 `$PROJ_DIR_THIRD/thunderbird-mcp`，版本 `0.7.4`，HEAD `41c73ae`。研究期间未修改第三方工作区。

| 文件 | 核对内容 |
|---|---|
| `package.json` | `thunderbird-mcp` 可执行入口、版本与运行时约束 |
| `mcp-bridge.cjs` | stdio JSON-RPC、连接发现、HTTP 转发、附件路径读取 |
| `extension/manifest.json` | Manifest V2、权限、Experiment API、最低 Thunderbird 版本 |
| `extension/background.js` | 扩展启动时启动本地服务 |
| `extension/mcp_server/api.js` | HTTP server、session token、connection file、工具分发与权限校验 |
| `extension/httpd.sys.mjs` | Mozilla 特权环境中的 HTTP server 实现与许可证边界 |
| `SECURITY.md` | stdio、loopback、特权扩展三层信任边界 |
| `test/*.test.cjs` | 认证、权限、参数验证、连接刷新、协议与压力测试 |

## 已确认架构

```mermaid
flowchart LR
  CLIENT[MCP Client] -->|JSON-RPC over stdio| BRIDGE[mcp-bridge.cjs]
  BRIDGE -->|Bearer token + HTTP| EXT[Thunderbird Experiment API]
  EXT --> TB[Thunderbird 特权 API/XPCOM]
  EXT --> FILE[connection.json]
  BRIDGE --> FILE
```

- bridge 是常驻 MCP server 进程，处理 `initialize`、`ping`、`resources/list`、`prompts/list` 等生命周期或空集合响应。
- `tools/call` 通过 `127.0.0.1` HTTP 转发给扩展。
- 扩展默认尝试端口 `8765` 至 `8774`，启动时生成 32 字节随机 token。
- connection file 包含 `port`、`token`、`pid`；目录目标权限为 `0700`，文件为 `0600`。
- bridge 会扫描普通临时目录、macOS `/var/folders`、Snap 和 Flatpak 位置，并按新鲜度尝试候选。
- 扩展运行于 Experiment API/XPCOM 特权边界，认证或授权缺陷可直接扩大为邮箱数据访问。

## 可借鉴的设计

| 能力 | 借鉴方式 |
|---|---|
| 动态端口发现 | 保留，但 descriptor 改为多实例、版本化结构 |
| 启动期随机 token | 保留 256-bit 随机会话凭据，移除稳定 token 选项 |
| 文件权限 | 保留目录 `0700`、文件 `0600`、symlink 拒绝与原子写入 |
| 陈旧发现信息自愈 | 保留周期校验、进程退出清理与 CLI 端 stale detection |
| 候选发现 | 保留 macOS 临时目录差异的经验，缩小为可信根目录和显式 override |
| 认证优先 | 所有错误细节、路由和业务参数解析前先认证 |
| 账号 allowlist | 保留扩展侧强制作用域，配置损坏时失败关闭 |
| 参数 allowlist | 每个 endpoint 使用严格 schema，拒绝未知字段和继承属性 |
| 身份选择 | 发件身份只能来自 Thunderbird 当前 profile 已配置 identity |
| 附件保护 | 保留 symlink、敏感路径、数量、单项与总量限制 |
| 草稿优先 | 保留 review-first 思路，升级为 CLI 与 Skill 双层规则 |
| 可逆删除 | 默认移入 Trash，不把永久删除纳入 MVP |

## 必须排除的设计

| 排除项 | 原因 |
|---|---|
| MCP server 注册 | 会引入常驻工具面和固定上下文成本 |
| JSON-RPC envelope | 本项目使用稳定领域 CLI 和版本化本地 HTTP contract |
| stdio bridge | CLI 是一次性调用者，不维护 MCP 消息循环 |
| `initialize`、`ping` | 不继承 MCP 生命周期；健康检查使用 `GET /v1/status` |
| `tools/list`、`tools/call` | 不提供动态工具枚举或通用工具分发入口 |
| 40 个工具 schema | 仅为当前命令解析所需 schema 付出上下文与运行成本 |
| listen-all | 服务只能绑定数值回环地址 `127.0.0.1` |
| stable auth token | 与“每次扩展启动生成短期凭据”的目标冲突 |
| 单个固定 `connection.json` | 多 profile/多实例会覆盖或误连 |
| bridge 读取任意附件路径 | 新 CLI 只接受经策略验证的输入文件，并尽量由 Thunderbird UI 选择 |
| `skipReview` 类普通布尔开关 | 外发确认不可由通用 flag 静默绕过 |

## 发现的安全缺口与改进

第三方实现未显示完整的 `Host` 精确 allowlist 和 `Origin` 校验，并存在 listen-all 与稳定 token 配置。新设计将：

1. 只绑定 `127.0.0.1`，不解析 `localhost`，不接受 IPv4/IPv6 任意地址。
2. 精确验证 `Host: 127.0.0.1:<descriptor-port>`。
3. CLI 请求默认不带 `Origin`；扩展拒绝浏览器来源的非空或非明确允许 Origin。
4. Bearer token 之外还验证协议版本、client kind、request ID、时间窗口和一次性 nonce。
5. descriptor 按实例分文件，不从世界可写目录中的任意路径盲目信任内容。
6. 认证失败统一返回最小错误，不暴露 endpoint、版本、profile 或账号信息。

## 许可证边界

当前项目只记录设计事实，没有复制第三方源码。若后续复用 Mozilla `httpd.sys.mjs` 或其他 MPL-2.0 文件，必须：

- 在文件级保留原许可证与版权声明。
- 公开该 MPL 文件及修改内容的源代码。
- 在发布包中提供 NOTICE/许可证信息。
- 不把“接口思想借鉴”误记为“源码可无条件复制”。

## 研究结论

技术上最可行的路径是保留“Thunderbird 特权扩展 + loopback 服务 +受保护 descriptor”的核心，但用专用、窄、版本化的 CLI API 替代 MCP bridge。安全基线必须比研究对象更严格，尤其是多实例、Host/Origin、防重放和稳定 token 方面。
