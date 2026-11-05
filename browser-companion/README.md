# Web Harness Relay Companion

这是 Web Harness 0.2.9-rc.7 Relay 的 Chrome / Edge Manifest V3 companion。A/B 是**稳定逻辑 Lane**，具体 ChatGPT 对话则是可替换的 Worker generation。Companion 是 Browser Control Plane：负责浏览器执行与观测，但不拥有 Goal/Driver authority。

1. 上报 Chat Worker 的浏览器健康状态；
2. 执行 Relay Manager 下发的 worker-targeted provision / activate / probe / recovery command；
3. 在需要替换 Worker 时通过 MV3 `chrome.tabs.create` 创建普通 fresh Chat，并把 provision transaction 持久化后再 reconcile；
4. 在安全的 handoff/recovery 已准备好后，只投递一次带唯一 marker 与一次性 claim ticket 的 Turn。

它不是新的 Goal truth domain，也不拥有文件、进程、浏览器或 Operation Journal 的写权限。真正的执行授权仍由 MCP 侧 `Driver Lease + epoch` 决定。

## Goal 选择与并发

在扩展 popup 的 **Goal ID** 中填写本次要连接的 Goal，并保存配置。刷新状态时，如果还未选择 Goal，只会列出可选择的 Goal 身份，不会自动接管其中一个。Desktop 的配对凭据仍按账号管理，Goal 身份由这一明确选择或已经验证的 Worker 绑定提供。

每个 Goal 分别保存 A/B Lane、Worker generation、Driver lease、命令及交接记录；两个 Goal 可以各自拥有 `A:g1`。命令、心跳、浏览器绑定和确认都同时携带 Goal 身份。改变 popup 当前查看的 Goal 不会重写已有标签页的归属，一个 Goal 的交接或结束也不会改变另一个 Goal 的权限。扩展共享的 2 个受管标签页上限和 30 分钟创建预算仍然生效。

旧记录只在明确匹配同一 Goal 时迁移；没有 Goal 归属的活动或不确定记录需要先对账。读取状态不会执行迁移。Bootstrap 提示包含精确的 `goal(action=status, handoff_id=<command_id>)`，用于确认是哪一个 Goal 的哪一次命令；它仅证明 capability，不授予 Driver authority。

## 安全边界

- 扩展只匹配 `chatgpt.com` / `chat.openai.com` 与 loopback `127.0.0.1`。
- 扩展使用单独的 `HARNESS_COMPANION_TOKEN`；**不要把 `ADMIN_TOKEN` 填进扩展**。
- Companion API 只能上报 Worker/lane heartbeat、领取受限 Relay command、确认 command 的执行结果并读取窄化的 Worker 状态；它不能调用完整 Admin API，也看不到 MCP session ownership 或 claim secret/hash。
- token 存在浏览器扩展自己的 `chrome.storage.local` 中，因此该 token 必须被视为“低权限本地 capability”，而不是 Admin/MCP/Tunnel 凭据。
- ChatGPT DOM 选择器属于 replaceable adapter，不是权威状态。适配器置信度低时必须 fail closed，不自动点击发送。
- adapter 把页面归类为 `CHAT / WORK / UNKNOWN`。只有具有独立正向证据的 `CHAT` 页面可以领取或执行 Relay command；Harness 插件 token 本身不是 Chat 证明，`WORK` 和 `UNKNOWN` 只会上报诊断。
- 一旦点击发送后结果不确定，扩展会进入 `activation_ambiguous`：后续只观察唯一 marker，**不会再次点击发送**。
- provision transaction 会先写入 `chrome.storage.local` 再 `tabs.create`；service worker 重启后会 reconcile 已知 tab/URL，无法证明唯一性时 fail closed 为 ambiguous，而不是再开一个 Chat。
- 即使服务端错误地换了 `command_id`，同一个 provision attempt / provision / Worker generation 仍只允许一个受管标签。扩展最多保留 2 个 live 受管 Worker 标签、每条 Lane 最多 1 个；此外 30 分钟滚动窗口最多允许 2 次 `tabs.create`，关闭标签页或重启 MV3 service worker 都不会清空预算。
- 暂停自动化也必须暂停自动身份修复：只有服务端状态明确为 `automation_enabled=true` 才能计划替换；旧 Companion 发出的自动替换请求在任何状态修改前被拒绝，已排队或已领取的自动建页命令也不能在暂停时重新领取。明确的 operator replacement 与 retirement/cleanup 不受影响；未知命令来源在暂停时 fail closed。已经送至浏览器执行中的命令仍须逐项对账，暂停不等于撤销既有副作用。
- fresh Worker 从普通 `https://chatgpt.com/` 起步，并在确认 Chat surface 后通过 `+` 菜单精确附加 Harness 插件；不再访问会落入 Work 的插件详情页 / `Try in chat` 路径。
- bootstrap 收据只证明浏览器与 MCP capability，永远不会把 READY Worker 提升为 ACTIVE、切换 Lane、递增 epoch 或淘汰当前 Driver；只有显式 `HANDOFF / RECOVERY goal(bind)` 能移动权限。
- `Message delivery timed out` / `Connection interrupted` / `ChatGPT stream recovery polling timed out` 只从局部错误、live-region 或 Retry/重试 UI 识别；不会扫描整段聊天记录，避免把用户讨论错误文字误当成运行时故障。恢复轮询超时是网页可见故障，不单独证明后台推理已经结束，也不授权自动点击 Retry 或重放有副作用的工具。

## 0.2.9-rc.6 启用方式

Relay / Companion 默认关闭，不影响普通 Web Harness 行为。正式打包版直接在桌面启动器的“设置 → 初始化 → 高级选项”中开启：

```text
启用 Relay Core 与 Browser Companion
自动根据 Turn 风险/投递故障在 Worker generations 间接力 Goal
```

保存后按启动器提示重启该候选实例的 MCP。点击“打开扩展目录”会打开 Desktop 为当前账号物化的稳定 Companion 目录，而不是 Portable 每次启动产生的 `cgh-*` 临时解包目录。然后在 Chrome / Edge 的扩展开发者页面选择“加载已解压的扩展”。浏览器安全模型不允许普通未受管 EXE 静默安装此开发者扩展；Web Harness **不会静默安装浏览器扩展**，因此首次加载扩展仍是需要人工完成的浏览器安全步骤。

扩展加载完成后，Desktop 会在稳定扩展目录中刷新 `runtime-bootstrap.json`：其中的 endpoint 来自当前实例真实 `adminPort`，低权限 Companion token 会随 runtime 轮换。扩展优先消费这个 bootstrap，因此**不需要用户猜端口、不需要把 `3001` 当默认值，也不需要每次启动重新手填 token**。bootstrap 缺失或不是显式 `127.0.0.1:<port>/companion/v1` 时 fail closed 为 unpaired。

从 rc.1 升级时，已经绑定的 A/B 对话会作为兼容 Worker 导入。导入只使用浏览器身份/遥测，**不会根据 URL 或 tab 猜测 `bound_session_id`、Goal owner 或 Driver authority**。Manager 可以在后台为某个 Lane 创建 `A:g2` / `B:g2` 等后续 generation，并在新 Worker ready 后完成安全切换。

如果需要人工干预，popup 提供当前 Worker generation/status/URL，以及 **Replace A / Replace B / Open A / Open B** 的 operator escape hatch；Replace 复用与自动替换相同的 durable provision state machine，不走旁路。

首次兼容绑定（可选，仅用于把已有 rc.1/rc.2 固定 A/B conversation 导入为 legacy Worker）时：

1. 打开两个固定 ChatGPT 对话；
2. 在 Chat A 标签页打开扩展，确认 Desktop bootstrap 已自动配对，然后绑定为 `Chat A`；
3. 在 Chat B 重复操作并绑定为 `Chat B`；
4. 点击“测试连接”；
5. 已有 conversation URL 会被记住作为兼容 cache；浏览器重启后可恢复该 Worker 的浏览器映射，但 durable Worker Registry/Driver Lease 才是权威状态。

rc.3 **没有硬编码默认 Companion 端口**。每个账号/实例使用 Desktop 根据当前 `adminPort` 写入的显式 loopback endpoint；如果该 bootstrap 不可验证，Companion 不会回退到某个猜测端口。

## Worker lifecycle / 接力协议

正常自动接力：

```text
Lane A -> active Worker A:gN owns Driver epoch E
  -> risk threshold / localized delivery failure / verified dead-worker policy
  -> choose healthy standby Worker, or provision B:gM / replacement generation
  -> provision transaction persisted -> tabs.create in the existing logged-in browser profile
  -> composer detected -> bootstrap input -> Send rediscovered / bounded keyboard fallback
  -> formal /c/<id> conversation established -> one-time PROBE claim consumed
  -> real goal(action=status) MCP capability proof -> READY
  -> source Worker DRAINING (new side effects fenced)
  -> existing side effects drain
  -> Handoff v2 PREPARED with source/target Worker identity + effect refs
  -> Companion delivers one unique [WH-RELAY:*] Turn with one-time claim ticket
  -> target calls goal(bind, handoff_id=..., takeover_token=<claim>) using durable Resume Bundle
  -> Goal owner + Driver move to epoch E+1 with a new lease_id
  -> snapshot COMMITTED; target Worker ACTIVE
  -> old Worker revival/write fails DRIVER_LEASE_LOST
```

如果目标 Worker 在真正点击发送前失败，command 标记 `FAILED`，Relay Manager 会 abort/reconcile；如果点击后的结果无法证明，command 保持 claim/ambiguous，既不重发，也不擅自转移执行权。对于 dead Worker recovery，lease expiry 只是 liveness 信号之一：successor 必须已经有正式 conversation + fresh MCP capability proof，还必须满足 grace、无 generation/tool/mutation in-flight、无 unresolved operation effect、来源观测/能力探针与已授权 recovery policy；**TTL 单独永远不能转移 Driver authority**。

## 重要限制

当前 adapter 依据公开网页 DOM 做启发式检测，ChatGPT Web 的内部 DOM/Turn 生命周期不是公开稳定 API。因此：

- selector 变化必须通过版本化 adapter 更新；
- 任何 selector 不确定都应该导致 fail closed；
- 在正式启用自动接力前，仍需要在真实已登录浏览器中做一次隔离的 A/B 长跑与故障注入验收；
- `Driver Lease` 才是并发写安全边界，Companion 的 UI 判断永远不能替代 Gateway fencing。

