Web Harness **3.2.0 r4 修订版**，Windows 10 / 11 x64。GitHub 标签为 `v3.2.0-r4`；为保持本次已验证 EXE 的原始字节，程序内部版本号仍为 **3.2.0**。这是独立的新 Release，保留原 `v3.2.0` 及其附件。验证范围仍按本地开发候选如实记录。

### 下载

| 类型 | 附件 |
|---|---|
| Windows 安装版 | [ChatGPT.Web.Harness.Isolated-3.2.0-setup.exe](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.2.0-r4/ChatGPT.Web.Harness.Isolated-3.2.0-setup.exe) |
| Windows 便携版 | [ChatGPT.Web.Harness.Isolated-3.2.0-portable.exe](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.2.0-r4/ChatGPT.Web.Harness.Isolated-3.2.0-portable.exe) |
| 完整源码与固定构建运行时 | [Web-Harness-3.2.0-r4-source.zip](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.2.0-r4/Web-Harness-3.2.0-r4-source.zip) |
| 校验和 | [SHA256SUMS.txt](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.2.0-r4/SHA256SUMS.txt) |
| 验证摘要 | [VALIDATION.json](https://github.com/jamesmendax/chatgpt-web-harness/releases/download/v3.2.0-r4/VALIDATION.json) |

EXE 文件名沿用 3.2.0，修订由标签和 SHA-256 区分。Portable 的数据目录与实际 EXE 文件名、所在目录关联；升级前备份对应数据，并先退出要升级的实例。此发布操作不替换任何本机现有安装。

源码提交对应本标签；附件中的完整源码 ZIP 另含构建所需的固定 Browser Use、Chrome 和 Tunnel 运行时。GitHub 自动生成的 Source code ZIP/TAR.GZ 只包含 Git 文件，不含忽略的大型运行时。构建方法见 [源码构建说明](https://github.com/jamesmendax/chatgpt-web-harness/blob/v3.2.0-r4/docs/BUILD_FROM_RELEASE_SOURCE.zh-CN.md)。

### 主要修复

- Aura 动态画面可从保护模式恢复，修复帧调度异常、绘图上下文恢复和再次触发内存保护的问题；保留四档画质与独立光幕。
- 修复后台子进程占住命令输出导致后续命令堵塞、补丁上下文匹配和 GBK/UTF-16 文件编辑问题；改善账户配置故障隔离与服务启动失败处理。
- 隔离不同上游的 OAuth 令牌，修复并发读取、保存和断开授权时旧令牌重新出现的问题。
- 修复被拒初始化的资源清理、DELETE/GET 排空及 SDK 最终结果记录；结果缓存满额时读取不再误淘汰调用记录。
- 改进上下文缓存、分块事件扫描、进程输出背压及保留原始字节的原子编辑。
- Electron 回归现在检查实际完成信号与结果文件，拒绝未完成却正常退出的测试。

### 已验证

| 项目 | 结果 |
|---|---|
| 后端回归 | 144/144；额外本地 upstream、OAuth、bridge 集成通过 |
| 桌面回归 | 506/506 Node，0 失败、0 跳过；15 次 Electron 自动完成校验通过 |
| 产物完整性 | 两种 EXE 解包、ASAR、运行时清单、编译对照和源码 ZIP 往返核验通过 |
| 实际 Portable | 四页导航、画质/光幕、真实 IPC 设置保存及隔离进程清理通过 |
| Aura UI 持续观察 | **1230.715 秒、83 个样本**，异常事件 0；测试进程已清理 |

Portable 验收是禁用 GPU 的实际程序短测；持续观察使用源码版 Electron 的隐藏离屏 D3D11 绘制，未施加持续工具调用负载。**未完成两小时测试。**

真实 ChatGPT/新隧道、真实 OAuth 授权服务器、完整打包版 provider 验收及干净 Windows 的 Setup 安装/卸载尚未验证。真实键鼠、剪贴板、通知、设备/代理、GPU reset、睡眠和 RDP 也不在已验证范围内。

旧格式 OAuth 凭据保留但不会自动导入新身份存储，相关上游需重新登录。日志仍可增长，多文件编辑不构成跨文件事务；UI 观察结果不等于无内存泄漏证明。

产物 SHA-256、源码签名和详细覆盖范围见附件 **`VALIDATION.json`**。

主项目及第三方组件的 LICENSE、NOTICE 和来源记录均随源码保留。此次未新增代码签名；实际文件以附件校验和为准。
