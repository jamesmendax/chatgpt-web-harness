# 五仓优化学习点证据映射（0.2.6-rc.1 基线）

> 2026-09-14 的固定快照恢复、下一代流式恢复实现和新验证入口见 `FIVE_REPO_NEXTGEN_EVIDENCE_20260914.zh-CN.md`。机器可读的 origin/commit/tree/hash 清单位于 `D:\web_harness_z8_business\five-repo-study-20260912\PINNED_SNAPSHOTS_20260914.json`。

本文把交接文档 `HANDOFF_TO_NEXT_AI_20260912.zh-CN.md:198-334` 的五仓学习点逐条映射到固定快照和当前 `chatgpt-local-coder` 源码。参考仓库均使用交接中指定的 commit；当前实现、测试文件和状态以本文写入时的工作区为准，最终事实以随包验证记录为准。

状态词的含义如下：

- **0.2.5 已有**：在本版本基线中已有相应能力。
- **0.2.6 新实现/增强**：当前版本新增或明显加强，仍须以随包验证结果作为发布依据。
- **未采用/有限适配**：当前产品边界、协议或安全模型与参考实现不同；只记录已经存在的适配，不把缺失能力写成通过。
- **待验证**：源码和测试入口已经映射，但本轮没有把它写成通过，尤其是尚未执行的整包门禁。

## 固定参考快照

| 仓库 | 固定 commit | 固定源码 | 本地快照 | 交接范围 |
| --- | --- | --- | --- | --- |
| coding-tools-mcp | `bedb632e1afd2e9ec9b268a50fe0b04695c22c64` | [GitHub tree](https://github.com/xyTom/coding-tools-mcp/tree/bedb632e1afd2e9ec9b268a50fe0b04695c22c64) | `D:\web_harness_z8_business\five-repo-study-20260912\snapshots\coding-tools-mcp` | `HANDOFF...:198-220` |
| CodexPro | `587f7fd3a4644a847bba13aeb49336056052e1f6` | [GitHub tree](https://github.com/rebel0789/codexpro/tree/587f7fd3a4644a847bba13aeb49336056052e1f6) | `D:\web_harness_z8_business\five-repo-study-20260912\snapshots\codexpro` | `HANDOFF...:222-246` |
| Serena | `701e7c843f46c6a649203a488cece1bf19f1df90` | [GitHub tree](https://github.com/oraios/serena/tree/701e7c843f46c6a649203a488cece1bf19f1df90) | `D:\web_harness_z8_business\five-repo-study-20260912\snapshots\serena` | `HANDOFF...:248-273` |
| DesktopCommanderMCP | `a781f5a4b8cfebac6638bc6fcbd38fca6326be53` | [GitHub tree](https://github.com/wonderwhy-er/DesktopCommanderMCP/tree/a781f5a4b8cfebac6638bc6fcbd38fca6326be53) | `D:\web_harness_z8_business\five-repo-study-20260912\snapshots\DesktopCommanderMCP` | `HANDOFF...:275-300` |
| codex-chatgpt-web | `e85e3693fdb4e3e033348c08df0298c20fcdb612` | [GitHub tree](https://github.com/miuuyy/codex-chatgpt-web/tree/e85e3693fdb4e3e033348c08df0298c20fcdb612) | `D:\web_harness_z8_business\five-repo-study-20260912\snapshots\codex-chatgpt-web` | `HANDOFF...:302-334` |

## 1. coding-tools-mcp

固定来源为 `bedb632e1afd2e9ec9b268a50fe0b04695c22c64`。下列参考路径均位于固定快照的 `coding_tools_mcp` 或 `tests` 目录。

### 1.1 可重启识别的进程所有权

- **参考证据**：`coding_tools_mcp/processes.py:128-165` 的 `CommandRun` 保存进程、启动时间、工作目录、游标和完成状态；`coding_tools_mcp/server.py:817-823` 的 `exec` 通过 `command_id` 重新观察既有命令。
- **当前对应**：`src/lib/process-journal.ts:12-24` 持久化 `pid`、`cwd`、`command_hash`、`started_at`、`process_start_identity` 和完整日志；`src/lib/process-journal.ts:107-143` 在 Windows/Unix 校验 PID 对应的启动身份；`src/tools/shell.ts:345-444` 写入后台进程记录。`scripts/test-recovery-v2.mjs:24-66` 覆盖启动身份、journal 持久化和 PID 不匹配。
- **状态**：**0.2.5 已有（有限适配）**。PID journal、创建时间、cwd、命令指纹和 PID 复用拒绝的基础能力已有；没有 coding-tools-mcp 那种可重启后继续控制的跨进程 owner lease，恢复视图明确是 `control_available:false`，因此不能宣称完整所有权恢复。

### 1.2 长命令 session 与增量 stdout/stderr offset

- **参考证据**：`coding_tools_mcp/processes.py:244-307` 的 `snapshot_since_cursor` 返回绝对游标、尾部截断和遗漏字节；`coding_tools_mcp/server.py:817-823,849-855` 将 `command_id`、`offset`、`limit` 作为断线后观察接口。
- **当前对应**：`src/tools/shell.ts:345-444` 启动后台 session 并将 stdout/stderr 合并写入完整日志；`src/tools/shell.ts:495-558` 以字节 `offset`/`max_bytes` 分页，返回 `next_offset`、`eof` 和恢复状态；`src/lib/process-journal.ts:146-245` 在 UTF-8 安全边界读取页面。`scripts/test-process-recovery.mjs:8-60`、`scripts/test-recovery-v2.mjs:24-66` 验证分页、错位游标和恢复。
- **状态**：**0.2.5 已有 + 0.2.6 Unicode 增强（有限适配）**。持久化 combined log 和精确字节游标的基础能力已有；本版本补强 UTF-8/Unicode 安全边界，接口没有参考仓库的独立 stdout/stderr 绝对游标，采用 combined log 是当前产品契约。

### 1.3 staged/revision-guarded mutation

- **参考证据**：`coding_tools_mcp/changes.py:1-11` 定义行级 revision，`:30-39` 定义 action/revision 限制，`:74-95` 先完整校验 envelope，`:130-165` 限制编辑字段和数量；`tests/test_changes.py:242-289` 验证缺 revision 和旧 revision 拒绝。
- **当前对应**：`src/tools/filesystem.ts:592-634` 的 `write_file` 接收 `expected_sha256`、`create_only`，写前创建 checkpoint；`src/tools/filesystem.ts:964-1019` 的 `apply_patch` 在单文件/多文件变更前创建 checkpoint；`src/lib/checkpoint.ts:265-307` 持久化快照和索引。`scripts/test-coding-v2.mjs:12-31` 覆盖 create-only/CAS 冲突，`scripts/test-checkpoints.mjs:50-79` 覆盖创建、列出和恢复。
- **状态**：**0.2.5 已有（有限适配）**。checkpoint、普通文本 CAS 和编辑前检查已经存在；`apply_patch` 本身没有 coding-tools-mcp 的统一 revision envelope，因此不能把所有编辑都写成具备行 revision 守卫。

### 1.4 deterministic MCP dogfood、schema/compliance drift、latency/workload gate

- **参考证据**：`coding_tools_mcp/server.py:5845-5900` 固定工具 schema、输出和 annotation；`tests/compliance/test_mcp_contract.py:148-195` 验证断开客户端不终止共享命令；`tests/compliance/test_schema_drift.py:15-83` 检查 schema、annotation、文档和错误码漂移；`tests/compliance/test_dogfood.py:23-54` 要求修复路径只经 MCP dogfood；`benchmarks/runtime_latency.py:159-258,322-340` 与 `benchmarks/dogfood/mcp_deterministic_runner.py:260-347,519-729` 生成 p95、工作负载和结论门禁。
- **当前对应**：`scripts/test-f0-characterization.mjs:200-215,291-313` 检查 slim/full 工具 schema、annotation 和 27,000 字节 payload；`scripts/run-all-tests.mjs:185-198` 复核 31-tool slim catalog 和 payload 上限；`src/lib/effective-tool-registry.ts:80-89` 保留 schema 校验和风险提示。0.2.7-dev 将恢复后的 `process_input` 纳入默认 slim 面，同时把诊断型 `shell_status` 留在 full profile，避免为新增能力扩大 ChatGPT 默认 discovery 面。上述 deterministic/schema 门禁在 0.2.5 已有，本版本继续增加相关 cases；`scripts/release-benchmark-gate.mjs` 提供跨实现 latency/workload 门禁入口。
- **状态**：**0.2.5 已有 + 0.2.6 增加 cases（跨实现 benchmark 待验证）**。本版本没有完成新的跨实现 latency/workload benchmark 报告，测试入口不能代替执行结果；不得标记为完整通过。

### 1.5 bounded output/deadline/watchdog

- **参考证据**：`coding_tools_mcp/processes.py:15-25` 说明输出 head/tail 上限，`:437-460` 实现 reader/watchdog；`coding_tools_mcp/server.py:213-224` 分离单次等待和命令总时限。
- **当前对应**：`src/tools/shell.ts:260-306` 将短命令总时限限制为 90 秒，并要求长命令转为一次 `start_process` 后轮询；`src/tools/shell.ts:495-558` 限制分页 `max_bytes` 并优先完整日志；`src/lib/process-journal.ts:205-245` 实施 UTF-8 安全页界。`scripts/test-process-recovery.mjs:8-60` 验证页界，`scripts/test-agent-harness.mjs:116-150` 验证命令/后台日志存在。
- **状态**：**0.2.5 已有 + 0.2.6 增强（有限适配）**。短命令 deadline、分页上限、完整日志和恢复观察已存在或增强；当前没有参考实现同等的独立 watchdog 线程来管理所有后台进程的总时限，长任务超时仍需以进程状态和日志审计。

## 2. CodexPro

固定来源为 `587f7fd3a4644a847bba13aeb49336056052e1f6`。参考实现中的权限和 handoff 行为不会扩大本项目的 workspace 或 auth 边界。

### 2.1 canonical per-file lock + expected SHA

- **参考证据**：`src/fsOps.ts:42-97` 的 canonical target 和 per-file lock 让路径别名共享锁；`src/fsOps.ts:99-153` 执行 SHA precondition、临时文件发布和冲突拒绝；`scripts/test-coding-v2.mjs` 与 CodexPro `scripts/import-smoke.mjs:100-216` 分别覆盖本地 CAS/冲突和受保护导入的 hash/大小约束。
- **当前对应**：`src/lib/safe-text-write.ts:21-60` 解析既有目标/最深父目录并用 canonical lock；`:62-88` 读取稳定 SHA precondition；`:90-128` 使用 fsync 临时文件、create-only `link`、replacement rename，避免 backup gap。`scripts/test-safe-text-write.mjs:28-77` 覆盖并发 CAS、并发 create-only、symlink alias、外部修改冲突和残留清理。
- **状态**：**0.2.6 新实现/增强**。交接所说的 0.2.5 普通文本 CAS 已被跨进程 canonical lock、expected SHA、atomic no-backup 和 create-only no-clobber 强化；仍只约束遵守该锁的写入者，不能约束任意外部程序。

### 2.2 workspace allowed roots / session workspace 边界

- **参考证据**：`src/guard.ts:61-107` 的 `WorkspaceManager.openWorkspace` 解析真实 root、allowed roots 和稳定 workspace id；`src/guard.ts:137-165` 的 `PathGuard` 拒绝越界路径；`src/server.ts:491-494` 把当前 workspace、AGENTS 和边界纳入推荐工作流。
- **当前对应**：`src/lib/path-security.ts:20-40` 的默认配置将 cwd 作为工作目录而不是访问边界，绝对路径可直接解析，`getAllowedRoots` 默认返回全局配置范围；`scripts/test-path-rules.mjs:8-37` 验证嵌套指令范围，`scripts/test-agent-harness.mjs:52-73` 验证 slim catalog、文件大小和目录结果，但不证明 CodexPro 式 allowed-root 隔离。
- **状态**：**未采用/架构有限适配**。本项目当前用户契约是受宿主权限控制的本机文件访问，不能把当前 full-disk/绝对路径语义描述成 session allowed-root sandbox；引入该隔离需另行批准安全边界和迁移契约。

### 2.3 安全附件导入协议（MIME/size/path）

- **参考证据**：`src/importOps.ts:70-94` 只接受受限 attachment reference；`:120-166` 校验 HTTPS、host 和私网地址；`:220-286` 限制 content length、流大小、超时和重定向；`:320-399` 组合下载、hash、MIME 和 overwrite 保护；`scripts/import-smoke.mjs:100-216,242-278` 覆盖成功和拒绝路径。
- **当前对应**：`src/tools/filesystem.ts:116-122` 要求 attachment object 的 `file_id`、`download_url` 和可选 MIME/size；`:235-255` 拒绝非 HTTPS、local hostname 和私网/保留地址；`:797-876` 的 `save_chatgpt_file` 将授权引用流式写入 `.part`、核对大小/SHA 后原子发布。`scripts/test-mcp-session.mjs:128-140` 实际检查工具及 `openai/fileParams`/file schema，`scripts/test-tools.mjs:146-168` 实际检查流式字节、SHA 和大小上限；当前没有覆盖完整 save 路由 URL 拒绝分支的端到端测试。
- **状态**：**0.2.5 已有（有限适配）**。本项目已有受 ChatGPT attachment reference 约束的导入协议、HTTPS/路径/大小/SHA 保护和 MIME 元数据/检测结果；当前路由没有参考仓库式 MIME allowlist，测试覆盖 schema 与 stream helper，URL 安全分支的端到端覆盖仍是验证缺口，不能把参考仓库所有 attachment policy 直接等同进来。

### 2.4 stable endpoint / connection test / instance isolation

- **参考证据**：`src/config.ts:244-337` 保存 allowed roots、连接测试和运行模式；`src/http.ts:218-250` 稳定显示 endpoint/tunnel 并脱敏；`scripts/settings-smoke.mjs:524-532` 检查 stale connection 清理；`src/server.ts:2035-2065` 将受控验证命令与 session 分离。
- **当前对应**：`src/lib/mcp-upstream-manager.ts:53-73` 保存每个 server 的 connection、connecting、generation 和 15 秒 connect timeout；`:126-185` 对配置变更串行化；`:487-552` 复用同一 generation 的连接、拒绝过期连接并对 connect/listTools 设时限。`scripts/test-mcp-upstream.mjs:84-143,240-270` 覆盖重叠配置更新和 abort/连接生命周期。
- **状态**：**0.2.5 已有 + 0.2.6 增强（有限适配）**。当前 manager 已有稳定 server id、generation、连接复用、超时和 shutdown；没有 CodexPro 独立多实例启动器的完整 endpoint/instance 隔离语义，故只确认对应思路。

### 2.5 “handoff plan”与真正 executor 分离

- **参考证据**：`src/server.ts:2307-2470` 的 `wait_for_handoff` 只读取 handoff plan、hash 和终态摘要，不执行计划；`src/proContext.ts:158-196,203-285` 以受限文件和 hash 生成上下文；`scripts/execute-handoff-smoke.mjs` 验证读取/执行边界。
- **当前对应**：`src/tools/goal.ts:92-118` 明确 `status` 只观察、Goal 不授予平台权限且不自动恢复 ChatGPT；`src/tools/tasks.ts:55-164` 将任务 checkpoint/resume 与实际工具调用分开；`src/lib/operation-journal.ts:132-176,899-973` 再把 durable receipt 的观察、恢复和执行区分。`scripts/test-goal-mode.mjs:68-102`、`scripts/test-durable-tasks.mjs`、`scripts/test-operation-recovery.mjs:47-123` 覆盖这些边界。
- **状态**：**0.2.5 已有 + 0.2.6 durable operation 增强**。任务/Goal handoff 仍是状态与证据，不是自动执行器；本版本补强了副作用操作的 receipt 和恢复观察，不能把 handoff tool 或状态读取误写成自动恢复。

## 3. Serena

固定来源为 `701e7c843f46c6a649203a488cece1bf19f1df90`。当前实现保持本地 TypeScript backend，不把 Goal 或 stream recovery 硬依赖到 LSP。

### 3.1 LSP/IDE semantic backend

- **参考证据**：`src/solidlsp/language_servers/typescript_language_server.py:99-101,345-350` 声明 implementation capability 和 server capabilities；`src/serena/tools/query_project_tools.py:46-75` 将项目查询置于语义 server；`src/solidlsp/ls.py:1591-1603` 通过 language server 请求定义。
- **当前对应**：`src/lib/code-intelligence.ts:30-68` 建立受限 JS/TS 文件 inventory；`:140-188` 建立 TypeScript `LanguageService` 和 backend fingerprint；`src/tools/code-intelligence.ts:17-68` 暴露统一 `code_intelligence` 路由。`scripts/test-code-intelligence.mjs:6-50` 实际创建 TS fixture 并查询语义结果。
- **状态**：**0.2.5 已有**。本项目已有本地 TS semantic backend，但它是进程内 LanguageService，不是 Serena 的独立 LSP 进程/协议；该差异属于架构事实。

### 3.2 definition / references / implementation / diagnostics

- **参考证据**：`src/serena/tools/symbol_tools.py:252-339` 的 referencing symbols、`:342-396` 的 implementations、`:399-465` 的 declaration；`src/solidlsp/ls.py:1591-1603,1635-1726` 对应 definition/implementation/references；`src/serena/symbol.py:810-971` 暴露这些 LSP 结果。
- **当前对应**：`src/lib/code-intelligence.ts:265-308` 实现 definition/references；`:310-341` 调用 TS `getImplementationAtPosition` 并限制结果；`:343-356` 返回 syntactic/semantic diagnostics；`src/tools/code-intelligence.ts:43-58` 路由 diagnostics、definition、references、implementations。`scripts/test-code-intelligence.mjs:31-50` 验证 interface→class implementation、max-results 截断和多候选 ambiguity；`scripts/test-code-intelligence-cache-rename.mjs:20-62` 覆盖语义查询配套行为。
- **状态**：**0.2.5 已有 + 0.2.6 新实现 implementation action**。definition/references/diagnostics 是原有能力；interface→class implementations 查询是本版本新增，`scripts/test-code-intelligence.mjs:31-50` 是对应 focused test 入口，执行结果以随包验证记录为准。不得把 Serena 的全部语言支持范围推断到本地 TS 以外。

### 3.3 WorkspaceEdit rename

- **参考证据**：`src/solidlsp/ls.py:3153-3178` 生成 LSP WorkspaceEdit；`src/serena/code_editor.py:369-415` 应用 WorkspaceEdit 并执行 rename。
- **当前对应**：`src/lib/code-intelligence.ts:359-521` 用 TS `findRenameLocations` 组成跨文件变更，先校验 inventory、外部路径、SHA，再调用 checkpoint/CAS；`src/tools/code-intelligence.ts:60-68` 暴露 `rename_locations`/`rename_apply`。`scripts/test-code-intelligence-cache-rename.mjs:36-62` 覆盖 checkpointed cross-file rename、非法名称和截断保护。
- **状态**：**未采用/有限适配**。当前是 TypeScript LanguageService rename + 本地 CAS/checkpoint，结果没有 Serena 的 LSP WorkspaceEdit envelope；它满足本项目受限 TS 重命名契约，不能写成已实现通用 WorkspaceEdit。

### 3.4 symbol cache + backend fingerprint

- **参考证据**：`src/solidlsp/util/cache.py:9-23` 版本化 cache；`src/solidlsp/ls.py:2894-3008` 对实现结果去重并保存 backend fingerprint/cache version；`src/solidlsp/language_servers/typescript_language_server.py:571-592` 等待索引并选择定义 backend。
- **当前对应**：`src/lib/code-intelligence.ts:70-188` 对 TS service 做有界 LRU cache，并将 TS 版本、compiler options、config 和文件内容 hash 合成 fingerprint；`:150-188` 命中相同 fingerprint，变更后 dispose/invalidate。`scripts/test-code-intelligence-cache-rename.mjs:20-49` 验证 cache hit、源码变化失效和 rename 后失效。
- **状态**：**0.2.5 已有**。当前已有项目 config/cache/fingerprint；实现细节是本地内存 bounded cache，而非 Serena 的 server cache 文件，不能把两者的持久性等同。

### 3.5 ContentModified 有界重试与 pending request 取消

- **参考证据**：`src/solidlsp/ls.py:3281-3290` 注册 ContentModified retry；`src/solidlsp/ls_process.py:44-53,174-200` 设置 `-32801` 的最多 3 次重试，`:326-385` 取消 pending 并有界发送；`tests` 中的语言 server 生命周期测试覆盖这些协议边界。
- **当前对应**：本地 `src/lib/code-intelligence.ts:140-188` 直接同步读取文件并创建 LanguageService，没有 LSP request queue、ContentModified code 或 pending request cancellation。`scripts/test-code-intelligence.mjs:6-50` 验证语义查询和边界，`scripts/test-transport-resilience.mjs`/`scripts/test-operation-recovery.mjs` 的取消属于 transport/operation 层，不是 LSP ContentModified。
- **状态**：**未采用/架构有限适配**。当前没有可诚实映射的 ContentModified retry/cancel 实现；不为语义查询增加新的 stream 关键路径。

### 3.6 语义检索减少整文件读取和上下文体积

- **参考证据**：`src/serena/tools/symbol_tools.py:43-91,158-192,217-245` 限制 depth、compact view 和结果数；`src/serena/tools/query_project_tools.py:46-75` 将查询导向符号工具而非无界全文读取。
- **当前对应**：`src/lib/code-intelligence.ts:30-68` 跳过 node_modules/dist 等目录并限制文件数；`:277-356` 对 candidates、files 和 results 分页/截断；`src/tools/filesystem.ts:416-505` 的 `read_text_file` 使用 line/character continuation，`:512-567` 的 base64 读强制 chunk 上限。`scripts/test-code-intelligence.mjs:31-50`、`scripts/test-agent-harness.mjs:60-73` 验证结果/目录上限。
- **状态**：**0.2.5 已有 + 0.2.6 增强**。本地语义查询、inventory bound、结果 bound 和文件 continuation 已降低全文压力；这不是 Serena 全量符号图，也不证明所有上下文调用都走语义检索。

## 4. DesktopCommanderMCP

固定来源为 `a781f5a4b8cfebac6638bc6fcbd38fca6326be53`。本项目保留完整 process log 和精确 cursor，不退回 eviction-only buffer。

### 4.1 长进程与一次 MCP HTTP request 解耦

- **参考证据**：`src/tools/improved-process-tools.ts:19-58` 建立虚拟 session 并保存 child/output；`:95-105` 校验启动请求；`src/server.ts:1005-1044` 记录 interactive workflow 和 timing telemetry。
- **当前对应**：`src/tools/shell.ts:345-444` 将 `start_process` 后台 child 与请求生命周期分开，记录 cwd、pid、log path 和 journal；`src/tools/shell.ts:495-558` 通过后续 `process_output`/`process_status` 观察。`scripts/test-agent-harness.mjs:116-150`、`scripts/test-recovery-v2.mjs:24-66` 覆盖后台日志和 journal。
- **状态**：**0.2.5 已有 + 0.2.6 日志/Unicode 增强**。长命令从一次请求转为可观察 session、持久日志和重启识别的基础能力已有；本版本继续维护这些边界并强化日志页，恢复后只读观察的 control limitation 见 coding-tools-mcp 1.1。

### 4.2 interactive/session process lifecycle

- **参考证据**：`src/tools/improved-process-tools.ts:185-208` 区分 waiting/finished/running；`:266-340` 等待新输出、报告状态并分页；`src/server.ts:1005-1044` 描述 interactive 的持续观察契约。
- **当前对应**：`src/tools/shell.ts:345-444` 启动和收尾 stdout/stderr；`:599-629` 提供 `stop_process`；`:495-558` 返回 running/exited/recovered 状态。`scripts/test-process-recovery.mjs:8-60`、`scripts/test-recovery-v2.mjs:24-66` 验证完成、恢复和控制状态。
- **状态**：**0.2.5 已有 + 0.2.6 增强**。当前支持后台启动、状态、输出和停止；没有把失去 owner 后的 recovered record 伪装成仍可交互 session。

### 4.3 stdin / status / incremental output

- **参考证据**：`src/tools/improved-process-tools.ts:220-242` 写入 stdin；`:266-311` 等待增量输出；`:313-340` 统一返回 status/pagination；`test/test-process-pagination.js:21-55,61-111,146-165` 覆盖 new/absolute/tail/status。
- **当前对应**：`src/tools/shell.ts:345-444` 使用 `StringDecoder` 消费 stdout/stderr，关闭时 flush decoder 并写完整日志；`src/tools/shell.ts:495-558` 以 `offset`/`max_bytes` 返回增量页，`:599-629` 提供停止和状态边界。当前源工具没有暴露 stdin 写入契约；`scripts/test-process-recovery.mjs:8-60` 验证 UTF-8 边界，`scripts/test-agent-harness.mjs:116-150` 验证后台输出。
- **状态**：**0.2.5 已有 + 0.2.6 Unicode/output 增强（有限适配）**。本版本补上 `StringDecoder` 和 UTF-8 安全分页，避免多字节字符在断流页中损坏；stdin 当前未暴露，因此不能声称实现 DesktopCommanderMCP 的 interactive stdin 协议。当前输出页是持久 combined byte log，不声称拥有参考实现的独立 line/new/tail 三种协议。

### 4.4 process/search/file 统一 offset/new/tail 分页

- **参考证据**：`src/tools/improved-process-tools.ts:238-340` 支持绝对 offset、负 tail 和 new output；`src/handlers/search-handlers.ts:93-97` 让 search 使用 offset；`src/server.ts:951-977` 公开 process output 的分页契约；`test/test-process-pagination.js:21-140,215-238` 覆盖分页。
- **当前对应**：`src/lib/process-journal.ts:146-245` 只对持久 command log 做 byte-safe offset 页；`src/tools/shell.ts:495-558` 暴露 `next_offset`/`eof`；`src/tools/filesystem.ts:416-505,1090-1120` 对文件行读取和搜索提供 `offset`/`next_offset`，但 file/search/process 不是一个共享 handler。`scripts/test-process-recovery.mjs:8-60`、`scripts/test-search-cursor.mjs`、`scripts/test-grep-resilience.mjs` 覆盖各自边界。
- **状态**：**0.2.5 已有 + 0.2.6 Unicode 增强（有限适配）**。进程完整日志的精确 byte paging 基础能力已有，本版本强化 UTF-8 安全页界；文件和搜索已有独立 offset continuation，没有 DesktopCommanderMCP 的统一 new/tail API，不能写成完整协议等价。

### 4.5 配置 read-latest/mutate/temp+rename/cross-process lock

- **参考证据**：`src/config-manager.ts:197-228` 在解析重试后原子写；`:231-258` 的 `performConfigMutation` 获取锁、重新读取最新配置、变更后原子发布；`:260-313` 处理跨进程 watcher/retry；`test/test-config-cross-process-clobber.js:83-115`、`test/test-config-mutation-recovery.js:12-76` 验证 stale save 和 post-commit 不重放。
- **当前对应**：`src/lib/mcp-upstream-config.ts:92-146` 的 `load/save/mutateUpstreamConfig` 每次变更读取最新 JSON、纯函数合并、以 expected SHA CAS 重试最多 20 次，缺失文件用 create-only；`src/lib/mcp-upstream-manager.ts:126-169` 串行化 reload/update/upsert/remove。`scripts/test-safe-text-write.mjs:60-77`、`scripts/test-mcp-upstream.mjs:87-143` 覆盖并发配置和 stale manager。
- **状态**：**0.2.6 新实现**。配置变更已经采用 read-latest、纯变换、canonical lock/CAS 和 atomic publication；外部任意程序绕过锁时仍只能检测冲突，不能保证事务性。

## 5. codex-chatgpt-web

固定来源为 `e85e3693fdb4e3e033348c08df0298c20fcdb612`。该仓库只提供状态机和观察边界的参考；不复制登录、cookie、自动批准、配额绕过或平台权限规避。

### 5.1 send activation / accepted / completion 严格 turn 生命周期

- **参考证据**：`src/adapters/chatgpt-web/browser-worker.ts:1139-1177` 定义 `onSendActivated`、`onSubmitted`、外部进度、completion fence 和 checkpoint；`:3299-3393` 在 Enter 前后分别记录 activation/accepted；`:4696-4737` 将 staged send、accepted evidence、wait-new-assistant 和 send-accepted 分开。
- **当前对应**：`src/lib/browser-turn-fence.ts:70-87` 在发送前保存 baseline；`:118-181` 区分 accepted/running/tool activity；`src/tools/browser.ts:336-403` 的 `turn_send`/`turn_observe` 保持同一 session fence。`scripts/test-browser-turn-fence.mjs:16-85`、`scripts/test-browser.mjs:74-91` 覆盖 acceptance、等待答案和异常 DOM。
- **状态**：**0.2.5 已有 + 0.2.6 增强**。browser-turn-fence 已在基线存在，当前加强了 activation 后不可重发、post-tool baseline 和 DOM unknown 分支；它仍需最终浏览器/真实 iOS 场景验证，不能由 fixture 测试推出 iOS 已修复。

### 5.2 Send 激活后禁止 blind replay

- **参考证据**：`src/adapters/chatgpt-web/browser-worker.ts:2860-2889` 在同页 reconcile user turn，拒绝重复 user turn；`:4774-5005` 的 observation loop 在副作用发生后继续观察，不因一次观察失败重发；`src/adapters/chatgpt-web/turn-broker.ts:507-569` 固定 sent/completion 的重复语义。
- **当前对应**：`src/lib/browser-turn-fence.ts:89-145` 对 stale/wrong-tab/ambiguous observation 一律 `resubmit_allowed:false`；`src/tools/browser.ts:336-380` 拒绝已有 pending/unconfirmed send。`scripts/test-browser-turn-fence.mjs:16-31`、`scripts/test-browser.mjs:74-84` 证明并发 send 只有一次 activation、未确认 send 不会再次点击。
- **状态**：**0.2.5 已有 + 0.2.6 增强**。防重复发送是当前核心不变量；测试覆盖了本地 fence，候选包仍须以真实 browser regression 作为发布依据。

### 5.3 observation ambiguous 时只做 same-tab rebind

- **参考证据**：`src/adapters/chatgpt-web/browser-worker.ts:2751-2857` 在 DOM observation 恢复时绑定原 page 并重新读进度；`:2860-2889` 校验同页 turn identity，避免新页面重发。
- **当前对应**：`src/lib/browser-turn-fence.ts:89-117` 对 tab id 变化、时间倒退或 activity revision 回退只给出 `rebind_same_tab`/`observe_same_tab` 决策并保持 `resubmit_allowed:false`；`src/tools/browser.ts:380-403` 的 `turn_observe` 沿用原 browser session。当前代码没有自动执行 CDP/Page rebind，`next_action` 是调用方的恢复指示。`scripts/test-browser-turn-fence.mjs:58-73` 验证 wrong-tab rebind 决策和 stale read 不允许 resubmit。
- **状态**：**0.2.6 新实现/增强（决策层有限适配）**。same-tab rebind/stale observation fence 决策已落地，但没有自动 CDP rebind；不能声称已恢复所有真实 ChatGPT DOM 变化或 iOS WebView 状态。

### 5.4 generation / tool-inflight / MCP activity revision completion fence

- **参考证据**：`src/adapters/chatgpt-web/browser-worker.ts:1364-1440` 的 `ChatGptCompletionTracker` 在 post-tool baseline、in-flight 和稳定候选间设 fence；`src/adapters/chatgpt-web/turn-broker.ts:44-113,445-459` 保存 activity revision 并分离 completion fence；`src/adapters/chatgpt-web/turn-progress.ts:85-190` 记录 tool batch、ack 和 in-flight。
- **当前对应**：`src/lib/browser-turn-fence.ts:1-38` 将 `generation_active`、`tool_inflight_count`、`activity_revision` 和 `post_tool_baseline` 纳入状态；`:118-181` 在新的 activity 或 in-flight 时保持 running。当前仓库的 `scripts/test-browser-turn-fence.mjs:34-55` 验证工具批次和完成候选阻断；`scripts/test-browser.mjs:74-91` 验证浏览器工具的并发 send、DOM error 和 fence 保留。固定参考仓库的合约测试只属于上面的参考证据，不作为本项目执行结果。
- **状态**：**0.2.5 已有 + 0.2.6 增强**。基线 fence 已有，当前分支把 post-tool activity 和 strict baseline 分支补齐；当前本地 MCP activity revision 不是 ChatGPT 原生 generation 事件，映射保持有限。

### 5.5 completion candidate 后 fresh same-tab read

- **参考证据**：`src/adapters/chatgpt-web/browser-worker.ts:1364-1440` 要求候选稳定；`:2751-2857` 在 ack 前执行 fresh progress/DOM read；`:4774-5005` 用 fence begin、fresh read、commit 顺序关闭 race。
- **当前对应**：`src/lib/browser-turn-fence.ts:185-214` 只有在稳定候选后再次得到同 tab、递增时间和不回退 activity revision 才返回 complete；`src/tools/browser.ts:182-205` 将不可读 body 标记为 unknown/error，不当作 idle completion。`scripts/test-browser-turn-fence.mjs:43-55`、`scripts/test-browser.mjs:80-84` 覆盖 fresh read 和 unreadable DOM 不完成。
- **状态**：**0.2.6 新实现/增强**。fresh same-tab read 和 DOM error fence 是本版本针对断流 race 的增强；仅有本地页面 fixture 证据，真实平台页面仍待整包/人工验证。

### 5.6 interrupted web turn / transport 恢复状态机

- **参考证据**：`src/adapters/chatgpt-web/turn-broker.ts:266-315,379-459,1008-1080` 保存 broker lifetime、exact call id、activity id、tombstone 和 completion fence；`src/adapters/chatgpt-web/retry-policy.ts:3-70` 对可重试 browser failure 做最多 3 次和 TTL；`tests/compaction-browser-recovery.test.ts:9-83` 验证恢复场景。
- **当前对应**：`src/tools/browser.ts:336-403` 保持同一浏览器 session 的 send/observe fence；`src/lib/operation-journal.ts:132-176,398-557,899-973` 对 MCP 副作用提供 durable received/executing/completed/failed receipt、同 operation replay/observe、死亡 owner 的 unknown outcome 和安全 resume；`src/lib/invocation-gateway.ts:195-226` 将 invocation metadata 接入 journal。`scripts/test-operation-recovery.mjs:47-123` 覆盖并发 once、重启 replay、crash-after-effect 不重执行、跨进程竞争和 observe-only。
- **状态**：**0.2.5 已有 browser/transport 基础 + 0.2.6 新实现 durable operation**。browser broker/fence 的基础能力已在基线，当前最关键缺口（MCP 工具副作用 receipt、duplicate suppression、crash recovery）已新增；executing owner 死亡时故意返回 outcome unknown，不能把未知结果写成成功。

### 5.7 staged ack/commit 与 rolling checkpoint 边界

- **参考证据**：`src/adapters/chatgpt-web/rolling-checkpoint.ts:90-190,261-379` 保存 split marker、exact-parent checkpoint、commit/store/apply；`src/adapters/chatgpt-web/turn-broker.ts:445-459` 明确 fence begin/commit；`tests/rolling-checkpoint.test.ts:58-239` 覆盖 checkpoint 边界。
- **当前对应**：`src/lib/checkpoint.ts:265-307` 在 file mutation 前创建持久 snapshot/index，`src/tools/filesystem.ts:613-617,988-1019` 将 write/apply_patch 与 checkpoint 关联；`src/lib/operation-journal.ts:398-557` 先 durable claim，再执行副作用，最后持久化 terminal receipt。`scripts/test-checkpoints.mjs:50-108`、`scripts/test-operation-recovery.mjs:76-123` 覆盖 restore、crash 和 terminal/observe 语义。
- **状态**：**0.2.5 已有 checkpoint + 0.2.6 durable commit 增强（有限适配）**。本项目有文件 checkpoint 和 operation receipt 两类提交边界，没有 codex-chatgpt-web 的完整浏览器 rolling-checkpoint marker；不能把本地 checkpoint 直接等同于网页 turn checkpoint。

## 明确不采用的参考行为

- 不采用 coding-tools-mcp 的 `fake_readonly` 或削弱真实 `ToolAnnotations`/permission semantics 的兼容方式。
- 不因 CodexPro/Serena 的实现扩大 workspace、auth、外部路径信任、远程附件下载或平台权限；`src/lib/path-security.ts:20-40` 的当前访问契约必须由独立安全决策改变。
- 不把 Serena LSP/ContentModified 或外部浏览器平台变成 Goal、operation journal 或 stream recovery 的硬依赖。
- 不用 DesktopCommanderMCP 的 eviction-only buffer 取代 `src/lib/process-journal.ts` 的完整日志、绝对 byte cursor 和 UTF-8 边界。
- 不复制 codex-chatgpt-web 的登录、cookie 搬运、自动批准、配额绕过和任何 native authorization 规避。

## 随包验证边界

- 本文件保留每个学习点的源码和测试入口；入口存在不等于测试已执行，执行结果和对应 source/candidate fingerprint 见随包 VERIFICATION reports。
- 在获得完整证据前，本文不把完整 root 回归、desktop 回归、跨实现 latency/workload benchmark gate、source/desktop clean build、candidate 构建与候选验证写成通过。
- 真实 ChatGPT/iOS 中断场景的 live acceptance 仍未验证。
- 本文只记录固定参考、当前源码映射和验证边界；不把任何缺失能力、未执行门禁或本地 fixture 结果包装为发布成功。
