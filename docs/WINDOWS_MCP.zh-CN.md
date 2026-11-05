# Windows MCP 可选上游：本机安装与 Word 实测

记录日期：2026-10-18。项目：sbroenne/mcp-windows（第三方开源项目，不是微软官方 Windows 服务）。

## 已完成的结果

已将发布方 v1.3.28 的 Windows x64 自包含 EXE 安装到当前用户目录，并通过现有 Web Harness stdio 上游桥接连接。未替换现有 Computer Use / Browser Use，未重启当前 MCP/Tunnel，未删除文件。运行中的 Web Harness 可通过 `mcp_call` 调用 `server_id: sbroenne-windows`。

本次所有 Word 启动、窗口激活、正文输入、另存为和截图操作均通过 `web_harness.mcp_call -> sbroenne-windows` 执行。没有用 python-docx、Word COM 或原 Computer Use 生成/输入正文。

实际文档：

```text
D:\web-local\recovery-fix-b4014a2b\.validation-windows-mcp-a3467f39-20261018\windows-mcp-word-jiangshan.docx
```

正文恰为“江山如此多娇”，6 个字符，码点 `[27743,23665,22914,27492,22810,23047]`。Word UIA 文本读取、截图中正文/6个字/已保存标志、只读 DOCX XML 三者一致。

文档 13,723 字节；SHA-256：`9a7c2d2beecd1e165fb9191cebc15808303d127ff1b96824ebab9716eeb5ba3f`。

## 安装与来源

- 发布页面：https://github.com/sbroenne/mcp-windows/releases/tag/v1.3.28
- ZIP：windows-mcp-server-1.3.28-win-x64.zip，54,186,365 字节。
- ZIP SHA-256：`9ca69685222d3c4934680218b4a2b3b7ae5bd0c8d2ce8bc2220925f4bd924fe4`，同时核对 GitHub release asset digest 和该发布的 SHA256SUMS.txt。
- 已安装 EXE：`%LOCALAPPDATA%\WebHarness\upstreams\sbroenne-windows-mcp\1.3.28\Sbroenne.WindowsMcp.exe`。
- EXE SHA-256：`0e6a20a9eeebce4e292fa357f8348bce9d9c0f1e1780667d8c547f2fdb743295`。
- Authenticode 状态：NotSigned。哈希一致不等于数字签名或完整安全审计。
- 实际握手名称：`sbroenne.windows-mcp`；版本：`1.3.28+655b9fc92d03ad52a270067c6844ea1231c90559`。

这是当前用户运行环境的可选上游安装，不是重新构建的 Harness EXE/ZIP；原 rc.7 封存交付没有因此变成包含此上游的新安装包。

## 接入配置

实际配置来自当前进程的 `MCP_UPSTREAM_CONFIG`，不是任意源码目录下的同名文件。安装版账号配置的一般位置为：

```text
%APPDATA%\chatgpt-web-harness-isolated\accounts\<account-id>\runtime\profiles\mcp-upstream.json
```

原配置先做逐字节备份，再以 SHA-256 CAS 追加独立 stdio 上游。通过 `mcp_servers(refresh:true)` 加载，并通过 `mcp_tools` 完成真实工具发现。最终连接状态显示 18 个上游工具；配置中选择 12 个工具供代理暴露：

```text
app, window_management, ui_snapshot, ui_find, ui_click, ui_type,
ui_select, ui_read, ui_wait, keyboard_control, screenshot_control, file_save
```

代理前缀：`windows_mcp`；空闲超时 600 秒。运行环境没有 uv/Python/.NET 外部安装依赖，因为选用了发布方自包含 EXE。

注意：`expose: allowlist` 限制的是工具代理暴露；当前通用 `mcp_call` 路径不应被描述为已经具有同等的服务端动作沙箱。调用时仍须遵守任务授权和平台审批；`app`、`keyboard_control`、`window_management` 本身可执行多种动作。本次只用了任务内的启动、读取、激活、输入、保存与截图，没有使用删除/关闭文档/终止进程/注册表等动作。

## 可靠使用顺序

1. `mcp_servers()` 检查 `sbroenne-windows`，必要时刷新已知配置；不在持有旧 elementId 时随意重连。
2. `app` 打开目标应用，`window_management(find)` 确认实际主窗口；启动时返回的临时 splash HWND 不能直接当正文窗口。
3. 激活目标窗口后，以 `ui_find` 获取 elementId。优先限定窗口、层级和父节点，再读取快照。
4. 使用返回的实时 elementId。控件失效先只读重新查找，不盲目重复输入。
5. 写入后以 `ui_read` 或截图检查结果；按钮返回 `actionDispatched=true` 不代表保存已完成。
6. 保存到全新路径，确认标题和“已保存”，再读取文件内容核验。

## 本机 Word 观察到的限制与恢复

本次不是无故障直通测试：

- 第一次全窗口 `ui_snapshot` 在 Word 返回 HRESULT 0x80004005。激活窗口、先查一层控件，再限定文档内容父节点后成功读取。
- Word `Body` 编辑控件的 `ui_type(inputMode:keyboard)` 返回对象状态错误。先读回正文为空并截图确认，然后通过同一 Windows MCP 的 `keyboard_control(action:type)` 输入 6 字；`ui_read` 成功读回完整正文。
- `ui_click` 对文档区曾返回“无法观察到变化”。没有重复该点击；后续以实际文本和截图判定结果。
- 文件名输入工具返回的一个 elementId 随后失效；重新 `ui_find` 得到当前文件名控件，读回目标完整路径后只提交一次保存。
- Word 保持打开时，.NET 默认 `ZipFile.OpenRead` 遇到共享占用。改用只读 FileShare.ReadWrite 流并复制到内存核验，没有关闭 Word、修改文件或生成替代文档。

因此，这次证明该上游在当前环境可以完成真实 Word 工作流，但没有证明它对所有应用都比现有 Computer Use 更快或更稳定。建议作为补充引擎保留，不直接替换现有引擎。

## 验收记录

证据目录：`.validation-windows-mcp-a3467f39-20261018`，位于 `D:\web-local\recovery-fix-b4014a2b`。

关键文件：`installation.json`、`upstream-schema.json`、`mcp-upstream.before.json`、`word-before-text.png`、`word-jiangshan-saved.png`、`word-acceptance.json`。

关键实际调用证据：
- 输入：tool-604231a1-d528-43c1-84f6-d66bc9c6a54f。
- 正文读回：tool-08aa854f-19fd-4d0e-af36-2bd69463305b。
- 保存点击：tool-62c9f8ea-7f5b-4916-b4ea-06739ff486cd。
- 保存后窗口：tool-594f29d6-e767-4c30-b475-6561cdb81ac4。
- 最终原生截图及目视复核：tool-1c7c6f1a-c4ec-4a98-9b5a-adec56e8945f、tool-8869b276-2e89-4990-8178-2da9d89f1c3d。
- DOCX XML/字节/哈希核验：tool-b9266635-0e95-49d8-89d7-dd9b9dc3f346，exit 0。

原项目的 clean Windows / 90分钟 / 无人恢复等验收，以及 GitHub 登录建仓等先前事项仍保留，不能由本次 Word 成功替代。
