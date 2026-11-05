# Web Harness 3.2.0 开发与候选说明

本版本的目标是让已连接的网页模型直接调用本机电脑能力，并修复会话、浏览器、文件、命令和 Skills 的实际执行链。本文件描述行为与验证方法；本次运行的通过项、失败项、产物路径和哈希以 `.validation/`、候选目录的证据报告及 `.harness/v3.1/` 当前记录为准。源码修改不会自动更新正在运行的 EXE。

## 直接调用与记录

工具接受执行所需的参数，不要求先提交需求评分、意图版本、人工批准字段或评审分数。历史 `_intent`、`confirmed` 以及旧审批环境配置保留兼容解析时，不再具有产品授权含义。连接认证、账户边界、目标资源存在性、路径策略、同一资源的并发保护、原子写入和同一 operation ID 的防重复执行继续生效。

Goal 和 Task 是可选的进度记录。Goal 可使用普通文本验收项，后续按需补充命令、文件或视觉证据。模型声明完成与实际验证完成分别保存：未通过的验收项保持未通过，历史完成记录也不会自动把缺失证据补成已验证。同一操作结果未知时应查看原收据；无关的新操作可以继续，不能盲目重复可能已生效的操作。

视觉评审可以先评价或先列问题，分数和迭代次数用于描述，不构成执行门槛。修改或撤回评价保留原因与历史。对视觉结果的验证必须基于实际看到的图像及其产物版本；没有打开实际图像时不能宣称视觉通过。无 review ID 的状态查询只返回本会话最新记录或明确的空结果。

## 会话与账户连续性

统一身份来自受支持的请求正文 `_meta["openai/session"]`。其稳定哈希用于同一账户内的 Goal、Task、Skills、浏览器及活动记录。HTTP transport session、标题、语言、时间和未经信任的请求头均不能证明是同一个对话。

同一可信对话换 transport 后可以续接。不同账户或对话分别存储。缺少可信元数据时，基础工具仍可执行，但连续性标记为 unknown；冲突元数据不得静默合并。无法可靠归属的旧 Goal/Task 记录保留在原位置，不自动归入当前账户。

桌面对话索引采用版本化迁移，保存原 ID 和身份来源；迁移前的 v1 原字节保存在一次性备份中。历史未知身份不会仅凭名称、时间或相似 ID 被升级为可信对话。界面中的正式对话标签只接受可信的 openai/session 来源。

## 调用结果与诊断

每次调用有独立 invocation ID，并保留请求、运行时和账户归属。同一调用的 TOOL 与 MCP 两层日志合并为一个活动记录；并行请求即使复用 JSON-RPC ID 也不能互相取走结果。

结果区分成功、参数待修正、执行失败、仍在运行及结果未知。诊断包含可用的失败阶段、原始错误代码、退出码、是否超时、是否可能部分完成和完整日志路径。HTTP 200 只说明响应交付，不等同于工具成功。无法关联到具体调用的传输错误保留为日志，不虚增一次失败操作。

请求头诊断记录来自原始请求快照；内部会话恢复或协议初始化不得覆盖它。诊断不复制 Authorization 或其他凭据值。

## 浏览器、本地路径与截图

Windows 盘符和 UNC 路径先按本地路径识别，再判断 URL；合法文件路径通过标准 file URL 转换，正确处理空格、中文、百分号及井号的编码，并区分 URL 查询与片段。

独立截图会话按明确指定的浏览器、通过锁文件和内容校验的离线浏览器、Edge、Chrome、Playwright 缓存顺序选择。显式路径无效会返回错误。仅在浏览器启动尚未成功时尝试下一候选；导航失败不切换浏览器掩盖问题。导航采用 domcontentloaded 和明确期限，不因长连接无限等待。上下文与浏览器清理结果保留在诊断中。

浏览器选择的本地检查和截图成功不能证明真实 ChatGPT 页面已把工具请求交给新的候选版本。

## 文件、checkpoint 与命令

打包后的 Electron 使用物理文件接口访问真实文件，包括 app.asar 自身；普通 Node 使用原生文件系统。实现不依赖全局切换 noAsar。必须使用实际打包 Electron 另行验证 ASAR 的读取、复制、checkpoint 和恢复。

Checkpoint 是尽力保存：逐文件保存 blob 和索引，保留跳过、失败和不完整原因，避免把整个目录聚合进内存。快照目录与目标重叠时不递归捕获自身。多进程发布索引保持原子性；旧格式继续可读。删除结果区分执行前失败和可能部分完成，不承诺跳过的内容可恢复。

命令提供两种互斥形式：shell command 或 executable + args。后者以 shell:false 启动，保持参数边界与特殊字符。Windows PowerShell 文本使用 UTF-8；可按需要选择输出编码，包括 GBK/CP936 和 UTF-16LE。后台进程也保留执行方式、解码信息和原始日志。非零退出码与超时分别报告；开始执行后失败可能已产生副作用，不能仅凭报错重跑。

## Portable 数据与回退

Portable 将数据保存在与 EXE 名称对应的独立 `.data` 目录；并列放置或重命名会使用另一个数据目录。升级前应备份对应数据，明确选择迁移来源；仅回退 EXE 不会撤销已经发生的数据变更。旧账号配置、Skills、MCP 注册、会话显示和通知偏好的迁移范围及回退需以实际合成账号验收为准。

## 14 个 Anthropic Skills

每项 Skill 有独立的 `anthropic.<slug>` 身份和适配正文。集合入口继续可用。固定上游提交为 `ca45fc4`，原始文件与许可保留；适配内容不冒充上游原文。

| 独立 ID | 用途 |
| --- | --- |
| anthropic.academy-guide | Claude Academy 学习与课程指引 |
| anthropic.algorithmic-art | 生成式艺术 |
| anthropic.brand-guidelines | Anthropic 品牌规范 |
| anthropic.canvas-design | 画布设计 |
| anthropic.claude-api | Claude API 与 SDK |
| anthropic.discernment-nudge | 判断与思考提示 |
| anthropic.frontend-design | 前端设计 |
| anthropic.internal-comms | 内部沟通 |
| anthropic.mcp-builder | MCP 开发 |
| anthropic.skill-creator | 技能创建与评估 |
| anthropic.slack-gif-creator | Slack 动画 |
| anthropic.theme-factory | 主题样式 |
| anthropic.web-artifacts-builder | 网页产物构建 |
| anthropic.webapp-testing | 网页应用测试 |

项目和用户已安装的同名技能按现有来源优先级解析。手动调用限制及禁用偏好继续生效。读取资源不要求先取得 selection_id；旧 selection_id 可作为关联提示，不能成为额外握手门槛。内容哈希过期时返回可供重新加载的具体信息。分页保持 UTF-8 字节边界，参考文件可直接读取。

“服务端已构造内容范围”“模型声明应用”“产物哈希一致”和“工作流质量已验证”分别记录，不能互相替代。内容收据不证明宿主已收到内容，或模型已阅读、理解并应用。14 项注册、路由和资源测试之外，frontend-design、webapp-testing、web-artifacts-builder、skill-creator 仍需在真实网页进行代表性任务验收。此集合不包含另行受限的 Office 技能。

## 可重复验证与候选构建

使用标准 Node.js 24 和两个已锁定依赖树。测试必须使用临时运行目录、独立账号夹具和私有端口。

```powershell
& 'C:\Program Files\nodejs\node.exe' .release-tools/verify.cjs root
& 'C:\Program Files\nodejs\node.exe' .release-tools/verify.cjs desktop
& 'C:\Program Files\nodejs\node.exe' .release-tools/build-candidate.cjs --local-development
```

构建要求根包和桌面回归对应相同、未改变的源签名。local-development 产出独立的 Portable 与 Setup 文件和追溯报告，并明确保留未进行的验收，不自动发布。

| 验收层 | 必需证据 | 不可替代它的证据 |
| --- | --- | --- |
| 源码 | 当前源签名、完整测试收据、退出码、日志 | 旧 dist 的通过结果 |
| Portable | 确切 EXE 的实际启动、隔离账户、打包运行时和文件行为 | 解包目录或源码启动 |
| Setup | 确切 EXE 在干净环境的安装、运行与卸载 | 仅构建、解包或修改另一安装身份 |
| 真实网页 | 网页模型连接该候选后的工具调用、连续性和四项 Skills 任务 | 本地 MCP 模拟客户端或旧运行版本 |

Setup 安装卸载应在独立的干净 Windows 环境进行。现有验收脚本的 `HARNESS_REPLACE_EXISTING_INSTALL=1` 会替换已注册版本，不能用于保存现有运行环境的开发电脑。仅指定不同的安装目录并不隔离卸载注册或快捷方式。不得为了获得“通过”而终止现有 MCP/Tunnel、覆盖账户或改变全局平台权限。

源签名、runtime manifest、desktop manifest 与两种 EXE 的 SHA-256 应写入同次候选报告。正式发布和用户迁移仍是另一个明确操作。
