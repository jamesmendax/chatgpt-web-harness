<div align="center">

# Web Harness

**让 ChatGPT 在你的电脑上完成真正的工作。**

将 ChatGPT 网页端连接到本地开发环境，使用文件、终端、Git、浏览器和桌面操作能力。

[下载 Web Harness 3.1.2](https://github.com/jamesmendax/chatgpt-web-harness/releases/tag/v3.1.2) · [快速开始](#快速开始) · [系统架构](#系统架构)

![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011%20x64-0078D4?style=flat-square)
![MCP](https://img.shields.io/badge/MCP-Enabled-10A37F?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-64748B?style=flat-square)

</div>

## 核心功能

- **文件与代码** — 读取、搜索、编辑和管理本地项目。
- **终端与 Git** — 运行命令、执行测试、管理代码变更。
- **浏览器与电脑操作** — 使用 Browser Use、Computer Use 完成网页和桌面任务。
- **Skills** — 根据任务发现并加载对应技能。
- **长任务管理** — Goal、Task、执行日志与任务恢复。
- **多账户隔离** — 独立账户配置、连接和运行数据。
- **Aura 桌面界面** — 服务管理、实时状态、主题和通知。

## 快速开始

### 1. 下载并启动

从 [Releases](https://github.com/jamesmendax/chatgpt-web-harness/releases/tag/v3.1.2) 下载 Windows x64 版本：

| 类型 | 下载 |
| --- | --- |
| 安装版 | [Web-Harness-3.1.2-Setup.exe](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.1.2/Web-Harness-3.1.2-Setup.exe) |
| 便携版 | [Web-Harness-3.1.2-Portable.exe](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.1.2/Web-Harness-3.1.2-Portable.exe) |

安装版按向导安装；便携版直接运行，无需安装。

### 2. 配置 Web Harness

打开应用，创建或选择账户，设置本地工作区，启动 MCP 服务与 Tunnel。

### 3. 连接 ChatGPT

1. 在 Web Harness 中打开**接入指引**，查看 Connector 地址。
2. 在 [ChatGPT](https://chatgpt.com) 设置中启用**开发者模式**。
3. 在应用与连接器设置中添加自定义 MCP 连接器，填入 Web Harness 提供的地址。
4. 完成连接后，即可在对话中调用 Web Harness 工具。

> Web Harness 拥有本地文件和命令操作能力，请只为可信任务授权。

## 系统架构

![Web Harness 系统架构图](docs/architecture.svg)

**ChatGPT ↔ HTTPS Tunnel ↔ MCP Gateway ↔ 本地工具与工作区**

[Archify 交互式架构图](docs/architecture.html) · [架构图源文件](docs/architecture.archify.json)

## 许可证

[MIT License](LICENSE) · [Tunnel Client Apache-2.0 License](third-party/tunnel-client/LICENSE) · [NOTICE](third-party/tunnel-client/NOTICE)
