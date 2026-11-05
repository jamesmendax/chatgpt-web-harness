# Web Harness 3.2.0

**正式发布版本：3.2.0 · Windows 10 / 11 x64**  
GitHub 发布标签：`v3.2.0` · 源码：本仓库对应标签

## 下载

| 类型 | 文件 | SHA-256 |
| --- | --- | --- |
| 安装版（Setup） | [ChatGPT Web Harness Isolated-3.2.0-setup.exe](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.2.0/ChatGPT%20Web%20Harness%20Isolated-3.2.0-setup.exe) | `06d85ef8fbe32dc3dc54a1f1dd18ca0661b671b9da8c3be42bec7adb5e3198d5` |
| 便携版（Portable） | [ChatGPT Web Harness Isolated-3.2.0-portable.exe](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.2.0/ChatGPT%20Web%20Harness%20Isolated-3.2.0-portable.exe) | `81efb476cc08bdff7f7836b82c4d29089e9ce729f270e50db71e9ce9bf6912b8` |

建议从 GitHub Releases 下载并验证 SHA-256。Portable 直接运行；Setup 是安装程序。两者与旧版本保持同一产品身份，请在升级前备份既有账号与数据目录，避免在有正在运行的 MCP/Tunnel 时直接替换。

## 本次更新

- **Aura R5 界面**：保留用户审核通过的原版彩色光球、完整光幕及工作状态反馈。新增四档「极致／高／普通／节能」画质和独立的「动态光幕」开启／关闭，样式沿用原主题，界面不新增说明小字。
- **Renderer / GPU 内存保护**：动画闲置帧调度、隐藏窗口停止渲染、单场景 WebGL 复用与释放；分别监测 Renderer 和 GPU 私有内存。超限先减负，紧急时只恢复界面，尽量维持后台 MCP 与 Tunnel 服务。
- **3.2.0 MCP 后端**：改善受信会话身份续接、调用结果和错误追踪、文件 checkpoint、Windows 命令及编码、本地浏览器和截图，以及 14 个独立 Anthropic Skills 的路由与资源读取。
- **独立账户与后端**：保留多账户隔离、任务、活动日志、设置和本地 MCP 操作能力。

## 本地验证

- 后端根层 136/136 必要测试通过，额外上游／OAuth／Bridge 回归通过。
- 完整桌面端与真 Electron／preload／IPC／隔离 MCP 回归通过。
- **真实单文件 Portable 启动**：6/6 检查通过，确认真正解包并加载正确 `app.asar`、私有设置写入、四个页面、独立光幕与节能资源释放。
- **新打包 Electron 实际运行**：6/6 检查通过。
- 64 个匹配的 `app.asar` 文件与受测源码哈希一致；3,118 个后端运行时文件逐一通过 SHA-256 核验。
- 五分钟混合画质/光幕循环：210 次采样，Renderer 约 66–109 MiB，GPU 约 183–443 MiB，无持续增长到数 GiB 的现象。

## 验证边界与安全提示

**本版确实完成了源码、打包与 Portable 实际启动验收，但以下并非已经完成的测试：**

- Setup 在独立干净 Windows VM 内的实际安装、从旧版升级、卸载与回滚。
- 将本次 3.2.0 候选真实连接到 ChatGPT 网页后的九项外部验收。
- 连续数小时固定极致画质＋真实工具调用的长期 GPU/Renderer 内存压力测试。

早前约 10 GiB 异常进程没有保存完整堆快照。本版修复了已复现的调度缺陷，增加资源上限与双进程紧急恢复，但**不应解读为已证明所有显卡驱动或 JS 分配场景绝对不会泄漏**。

程序具有本地文件、命令、浏览器和电脑操作能力，请仅向可信任务授权，不要在公开 Issue、日志或截图中提交私人账号凭据。Windows 未签名 EXE 可能触发 SmartScreen，务必从本仓库下载并核对校验和。

## 许可证

主程序 MIT（保留原作者署名）；随附的 Tunnel Client、Anthropic-derived Skills 等依各自的 LICENSE 和 NOTICE 文件授权。更详细的实现与边界见 [3.2.0 技术说明](RELEASE_3.2.0.zh-CN.md)。

---

**历史版本：** [Web Harness 3.1.2](https://github.com/jamesmendax/chatgpt-web-harness/releases/tag/v3.1.2)
