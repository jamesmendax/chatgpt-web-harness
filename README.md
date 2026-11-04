# ChatGPT Web Harness

**将 ChatGPT 网页端的工具调用连接到你自己的 Windows 电脑。**  
*A local-first Windows desktop companion and self-hosted MCP tool runtime for ChatGPT on the web.*

![Windows x64](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0078d4) ![Release](https://img.shields.io/badge/release-3.1.0--alpha.2-7c70e0) ![License](https://img.shields.io/badge/License-MIT-3ca68a)

[**下载 Windows 版本 / Download**](https://github.com/jamesmendax/chatgpt-web-harness/releases/tag/v3.1.0-alpha.2) · [架构说明](#-系统架构--architecture) · [发布说明](docs/RELEASE_NOTES.md) · [隐私与安全](docs/PRIVACY_AND_SECURITY.md)

> **预发布版本 / Prerelease.** 当前为 Windows x64 的 `3.1.0-alpha.2` 候选。通过本地源码、桌面集成和离线 EXE 内容验证；**尚未在另一台干净的 Windows 电脑完成安装验收**，也未完成真实云端环境的最终互通验收。安装包未进行代码签名，Windows 可能显示 SmartScreen 提示。

## ✨ 核心能力

- **Aura 桌面界面**：简洁的深浅色界面、服务状态、工具动态和提示音。
- **本机 MCP 工具**：文件读写、目录与代码搜索、Shell、Git、后台进程，以及浏览器与桌面操作。
- **多账户隔离**：独立账户配置、会话记录；凭据由 Electron `safeStorage` 保护，Windows 上与当前用户绑定。
- **Skills 路由**：根据任务场景发现与加载适用的 Skills；是否实际调用仍由客户端模型和权限决定。
- **长任务状态**：Goal、Task、执行日志与恢复证据。不会把无法证实完成的操作直接标记为成功。
- **本机优先**：本机服务通过用户配置的 HTTPS Tunnel 与 ChatGPT 连接；不需要在 GitHub 或代码中填写个人连接密钥。

## 🧭 系统架构 / Architecture

![由 Archify 绘制的 Web Harness 系统架构图](docs/architecture.svg)

*使用 [Archify](https://github.com/tt-a1i/archify) 生成。 [交互式 HTML（下载后本地打开）](docs/architecture.html) · [图表源文件](docs/architecture.archify.json)。*

工作路径：**ChatGPT → HTTPS Tunnel → 本机 MCP 网关 → 工具执行核心 → Files / Shell / Git / Browser / Computer Use**。Aura 桌面应用负责账户与本机服务管理；Skills 路由与 Goal / Task 状态为独立的辅助能力。旧版自动网页接力/Companion 不属于本候选的运行链路。

## ⬇️ 下载与使用 / Getting started

前往 [Releases](https://github.com/jamesmendax/chatgpt-web-harness/releases/tag/v3.1.0-alpha.2)，任选一个 Windows x64 文件：

| 文件 | 用途 |
| --- | --- |
| `ChatGPT Web Harness Isolated-3.1.0-alpha.2-setup.exe` | Windows 安装版 |
| `ChatGPT Web Harness Isolated-3.1.0-alpha.2-portable.exe` | Windows 便携版；数据保存在同名 `.data` 目录 |

首次启动后，在应用内建立自己的账户与工作区，配置 MCP/Tunnel 连接参数，再根据 ChatGPT 开发者模式中的连接步骤接入。**发布包不包含任何现成的账户、API Key 或 Tunnel ID。**

> 安全提示：工具可以在授权范围内读取、修改本机文件并执行命令。只连接你信任的 MCP 客户端，仔细检查工作区、权限与高风险操作；不要把本机端口直接暴露到公网。备份配置后再升级或导入旧账户。

## 🔎 源码与验证 / Source & verification

本仓库包含 **独立整理的公开源码快照**，并未推送开发仓库的历史、运行数据或私人调试记录。源码中不包含 `node_modules`、运行时浏览器 ZIP、安装包或凭据；构建需要安装依赖并准备对应运行时资源。发布用 EXE 的实际内容已在构建时离线核对。

**二进制 SHA-256** 见 [发布说明](docs/RELEASE_NOTES.md)。本版理论上支持 Windows 10/11 x64，不支持 32 位 Windows。macOS、Linux 和 Windows ARM64 未作为此桌面候选的发布目标。

## English summary

ChatGPT Web Harness connects ChatGPT's MCP tool calls to a Windows machine through a user-configured secure tunnel. It combines an Electron Aura desktop launcher, an account-scoped MCP runtime, local development tools, Browser/Computer Use, Skills routing and durable Goal/Task records.

This is an **unsigned prerelease** and not a fully validated production distribution. Download only from this repository's Releases, verify SHA-256 checksums, supply your **own** connection credentials, and grant local tool permissions carefully.

## License & disclaimer

MIT License; see [LICENSE](LICENSE). This project includes MIT-licensed upstream work and third-party notices. Not affiliated with, endorsed by, or operated by OpenAI or GitHub.
