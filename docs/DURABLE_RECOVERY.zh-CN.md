# 持久命令恢复：运行与验收

本模块恢复的是已经授权并提交的可执行命令计划。只保存任务编号或阶段说明，不会产生可恢复工作。

## 启动条件

在独立工作目录中，用标准 Node.js 24 和锁定依赖构建。通过环境变量启用恢复宿主：

```powershell
$env:HARNESS_RECOVERY_SUPERVISOR_ENABLED = "1"
npm start
```

桌面安装包会转发该变量。需要在后续启动中持续启用时，应由启动环境持久提供；一次 PowerShell 会话中的设置不会自动变成桌面配置。状态目录和产物目录可分别通过 `HARNESS_RECOVERY_SUPERVISOR_STATE_DIR`、`HARNESS_RECOVERY_ARTIFACT_ROOT` 指定。使用独立目录，不能借测试重启正在工作的 MCP 或隧道。

打包必须同时包含 `service-recovery-guardian.mjs`、`service-recovery-host.mjs`、`service-recovery-worker.mjs` 和对应的 `dist/lib` 模块。源码启动成功不能替代这项检查。

## 提交与确认

1. 在当前 Goal 的授权范围内，调用 `recovery_submit`，提供稳定的 `task_id`、`operation_id`、命令、工作目录和明确的重放策略。
2. 检查提交回执中的任务、操作编号、计划 SHA-256 和存储位置。
3. 调用 `recovery_status`，确认执行器实际读取了该计划，并观察与同一操作对应的步骤、检查点及完成回执。提交文件存在本身不代表步骤已经执行。
4. 断开后继续读取同一任务的状态。结果不明确时核对既有回执，不能换编号盲目重复提交。

`side_effect=none` 只能用于确实不产生副作用的命令，才能配合 `replay_policy=safe`。可能写文件、发布、上传或修改外部状态的命令应按真实效果声明；结果未知时停止重放。不能为得到自动重试而把有副作用的命令标成无副作用。

## 执行约束

- 工作目录只能位于已配置工作区内，不能通过父目录或 junction 扩大范围。
- 产物根目录必须位于恢复宿主指定的产物目录内。
- 任务和操作编号保持稳定；重复操作编号、计划内容或工作区漂移不能复用旧成功回执。
- Windows 操作编号中的冒号使用哈希文件名存储检查点，避免无效文件名或替代数据流。
- 未知动作进入阻断状态；不会当作空操作成功。
- `max_automatic_recoveries=0` 禁止自动重试；预算保存在任务状态中，跨轮询和恢复调用累计。
- 状态替换对短暂 Windows 文件占用做有限重试，最终失败仍返回错误；并发计划发布只允许一个完整文件胜出。
- 已有回执缺少新工作区绑定时可能返回计划不匹配。须先核对旧结果，不自动重建任务或补写成功状态。

## 验证

```powershell
npm run build
node scripts/test-recovery-fault-matrix.mjs
node scripts/test-release-source-signature.mjs
node .release-tools/verify.cjs root
node .release-tools/verify.cjs desktop
npm --prefix desktop run dist
```

故障矩阵包含真实的隔离子进程退出、宿主恢复、MCP 客户端断开、稳定操作身份、未知结果阻断、路径边界及持久写入测试。测试只使用自有临时目录与进程。发布签名同时覆盖 Browser Companion、内置插件及发布校验器，相关修改会使旧验证失效。

## 原生网页验收边界

隔离客户端断开测试证明已提交的本地命令能继续运行，不证明 ChatGPT 网页推理流被恢复。原项目仍要求：一个真实网页任务超过 90 分钟的连续有效工作、真实中断、自动检测和无需人工 Retry/续接的同操作恢复。

网页的工具清单应真实暴露 `recovery_submit` 与 `recovery_status`；服务器内部清单或旧安装包的描述不能替代当前连接器可调用性。浏览器观测丢失时必须记录覆盖缺口，不能用本地心跳、等待时间或墙钟时长填充有效工作时间。
