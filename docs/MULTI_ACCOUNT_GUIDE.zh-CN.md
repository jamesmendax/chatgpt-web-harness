# ChatGPT Web Harness 多账号使用指南

本版桌面端把“账号”定义为一个**独立运行配置档**。每个配置档有自己的 MCP / Admin / Tunnel 端口、Tunnel ID、加密保存的 Runtime API Key、工作区、运行目录、日志、Skills / 插件配置和受桌面端管理的进程。

> 重要边界：这些配置档和进程仍运行在**同一个 Windows 用户**下，因此属于运行隔离，不是操作系统安全沙箱。拥有本机任意命令执行能力的配置档理论上仍可能访问该 Windows 用户有权限访问的其他文件。需要把互不信任的账号做成强安全边界时，应使用不同 Windows 用户、ACL、VM 或独立主机。

## 1. 现有账号会怎样

升级后，原来唯一的一套桌面配置不会被复制或清空，而是作为 `默认账号（原配置）` 保留：

- 原配置仍在原 userData 根目录；
- 原工作区、Tunnel ID、加密密钥和设置保持原位；
- 新建账号不会继承或复制原账号的 Tunnel ID / Runtime API Key；
- 新账号使用 `<userData>\accounts\<account-id>\` 下的独立数据根。

账号索引仅保存账号 ID、显示名称和创建时间，不保存明文密钥。账号索引损坏或被另一实例并发修改时会 fail closed，不会自动重置旧配置。

## 2. 创建第二个账号

1. 打开桌面端，在左侧“当前账号”区域点击 **+ 新账号**。
2. 输入容易识别的名称，例如 `Business B`、`个人 Plus`、`公司账号 2`。建议让它和 ChatGPT 里的 Connector 名称一致。
3. 软件为该账号自动分配三个当前未占用、且不与其他配置档重复的本地端口：MCP、Admin、Tunnel health。
4. 软件自动建立独立运行目录和默认工作区；你也可以在“设置 → 初始化”里改成自己的目录。
5. 为这个账号填入**它自己的** Tunnel ID 和 Runtime API Key。不要复用第一个账号的 Tunnel ID。
6. 保存后点击 **启动当前账号**。这只启动当前配置档的 MCP 与 Tunnel；第一个账号已经运行的服务不会被停止。

如果你修改当前账号的端口、工作区或 Tunnel ID，软件会先检查：

- 三个本地端口在本账号内互不重复；
- 不与其他账号已保存的 MCP / Admin / Tunnel 端口重复；
- Tunnel ID 不属于另一个账号；
- 工作区与其他账号的工作区不相同、也不互相包含；
- 工作区不放在桌面端账号数据目录里面，也不反过来包含账号数据目录。

当前账号自身的 MCP / Tunnel 正在运行时，软件会要求先停止**这个账号**再修改这些设置；不要求停止其他账号。

## 3. 在第二个 ChatGPT 账号里连接

每个 ChatGPT 账号应创建自己的 Connector：

1. 在桌面端切到第二个配置档，确认页面顶部显示的账号名称以及对应的 MCP / Admin / Tunnel 本地端口。
2. 启动当前账号，确认 MCP 与 Tunnel 状态正常。
3. 登录第二个 ChatGPT 账号，打开 **Settings → Connectors** 并开启 Developer mode。
4. 新建 Connector，建议命名为 `Web Harness · <桌面账号名>`。
5. Connection 选择 **Tunnel**，选中这个配置档对应的 tunnel，或填入这个配置档的 Tunnel ID。
6. 保存后开一个新对话，添加这个 Connector，先做只读探针，例如：`请只读取工作区目录列表，不要修改任何文件。`
7. 回到桌面端切到第一个账号，不会让第二个账号的 MCP/Tunnel 停止。你可以分别查看、启动或停止各配置档。

## 4. “切换账号”和“启动账号”的区别

**切换账号**只改变桌面 UI 当前控制哪一套配置和进程；它不会停止后台其他账号。

**启动当前账号**只启动当前配置档自己的 MCP/Tunnel。多个账号可以同时运行，只要它们使用不同的端口、Tunnel ID 和工作区。

**停止当前账号**只停止当前配置档由桌面端启动的服务，不会终止其他账号。多账号模式不会接管仅因为“端口/命令行看起来像 Harness”而发现的外部进程，以免误杀另一个实例。

退出桌面应用时，会停止**本应用本次管理的所有账号进程**；不会把未知外部进程当成自己的服务接管。

## 5. 数据隔离结构

逻辑结构如下：

```text
<desktop userData>\
├─ config.json                  # 默认账号：兼容原配置
├─ runtime\                    # 默认账号运行目录
├─ accounts.json               # 账号索引，不含明文密钥
└─ accounts\
   └─ <32-hex-account-id>\
      ├─ config.json            # 第二账号独立配置/加密密钥
      ├─ state.json
      ├─ launcher.log
      ├─ runtime\
      │  ├─ .codex\
      │  ├─ .mcp-state\
      │  └─ profiles\
      └─ ...
```

MCP 子进程还会得到该配置档自己的 `CODEX_HOME`、`MCP_SHELL_STATE_DIR`、plugins/upstream MCP 配置路径和 `HARNESS_ACCOUNT_ID`。Tunnel 进程只获得自己的 tunnel credential；MCP 进程不会继承 tunnel API key。

## 6. 已验证与未验证的范围

本轮本地验收覆盖了：

- 旧单账号配置保留为默认账号；
- 新账号不复制旧账号凭据；
- 端口 / Tunnel ID / 工作区冲突拒绝；
- 账号索引损坏、并发覆盖、缺失配置 fail closed；
- 同时启动两个真实 MCP 进程，分别使用不同 PID、端口、运行目录和工作区；
- 停掉其中一个后，另一个 MCP 仍健康；
- 真实 Electron UI 创建第二账号、切换回原账号并保持原配置；
- 多账号模式下不接管未知外部进程；
- UI 明确显示当前账号和对应端口。

**没有**使用你的真实第二账号 Runtime API Key / Tunnel ID 做云端授权。因此本轮只能证明第二套本地 MCP 运行链路和 tunnel 配置隔离已经实现，不能声称第二个真实 ChatGPT 账号已经完成云端连接。你把第二账号自己的 tunnel 凭据填入该配置档后，按第 3 节完成真实 Connector 连接即可。

## 7. 安全建议

- 不要让两个账号共用同一个 Tunnel ID。
- 不要让两个账号指向相同或互相包含的工作区。
- 不要把真实 Runtime API Key 写入仓库、截图或问题报告；桌面端使用 Electron `safeStorage` 加密保存。
- 如果账号之间存在互不信任的代码/用户，使用 Windows 用户、ACL 或 VM 做强边界，而不是仅依赖本功能。
- 对多账号 Connector 使用一致、可辨识的命名，避免在 ChatGPT 里误选另一个账号的 tunnel。
