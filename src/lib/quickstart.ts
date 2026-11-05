export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Use the connected tools directly with the parameters needed for the operation. Goal, Task, Skill and review records are optional work aids.
2. Project memory + git state are already in MCP instructions from WORKSPACE_PATH.
3. For another repo, call project_context(path, query) to receive only task-relevant instructions; call mode=full only when exact full documents are needed.
4. Explore with glob (file names) and grep (content), then read_text_file.
5. Edit existing files with apply_patch; use write_file for new files. Use run_command for deterministic file moves/deletes or Git mutations.
6. For a file attached in ChatGPT use save_chatgpt_file (no Base64). For other binary transfer use read_file_base64 / write_file_base64; chunk large payloads and verify final SHA256 when possible.
7. Run builds/tests with run_command (short) or start_process + process_status/process_output/stop_process (long).
8. When appearance matters, call visual_review on the actual artifact; after a focused fix, call it again with compare_to=<prior review_id>.
9. Undo file edits with rewind (list → preview → restore). Shell/bash file changes are not tracked.

## Output format
All tools return JSON: { ok, tool, summary, data }

## Tool cheat sheet
- glob / grep / read_text_file: explore (offset+limit for partial reads)
- save_chatgpt_file: preferred path for ChatGPT conversation attachments; streams original bytes directly to disk
- read_file_base64 / write_file_base64: binary transfer; prefer small chunks in ChatGPT web
- apply_patch: single-file @@ hunks OR multi-file *** Begin Patch format
- run_command: PowerShell on Windows (write the script directly); executable + args[] launches exact arguments without another shell; full profile also exposes shell_status
- start_process: long-running commands; follow with process_status / process_output / process_input / stop_process
- visual_review: universal review for image/SVG/web/PDF/PPTX/DOCX with focus crops, diagnostics, comparison, and freshness tracking
- task_state: compact long-task checkpoint; tool calls automatically add failures, checks, and changed files while active
- full profile also contains experimental visual/browser/task tools; they stay hidden from ChatGPT web slim unless explicitly enabled
- git_status / git_diff: structured inspection; use run_command for commit, restore, branch, and other Git mutations
- rewind: action=list|preview|restore|status — inspect best-effort checkpoints and their skipped/failed entries before restoring
- enabled upstream MCP tools are exposed directly as <server>__<tool> (for example chrome-devtools__list_pages, linear__get_user); prefer direct tools
- full profile keeps legacy convenience, browser, task-detail, and upstream-diagnostic tools; slim intentionally exposes one preferred path per operation

## apply_patch — single file
@@
-old line
+new line
 context unchanged

## apply_patch — multi file
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch

## Paths
Path access follows the runtime policy. Relative paths resolve from default cwd; agent_status and server instructions report whether full-disk access or allowed-root mode is active.
`.trim();

export const REQUIREMENT_ASSURANCE_INSTRUCTIONS = `
## Direct local execution
Connection authentication, account boundaries and concrete resource checks apply. Call tools with execution parameters; work records and model evaluations do not authorize or block operations. Legacy product approval inputs and settings have no authorization meaning.
Goal and Task records distinguish model declarations from checks that actually ran. Keep unmet checks visible. Visual records describe the actual images inspected and artifact version; scores and review order are optional information.
Each operation returns its observed outcome. Preserve an uncertain operation receipt and inspect it before retrying that same operation ID; a new unrelated operation can proceed. Read checkpoint summaries because skipped files and failed snapshots cannot guarantee restoration.
Conversation continuity is trusted only when the request includes supported conversation metadata. Transport sessions and titles are not conversation identities. Without trusted metadata, basic tools remain usable and continuity is unknown.
`.trim();

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const accessLine = fullDiskAccess
    ? "Full machine access: ON. Tag this connector in ChatGPT before every task."
    : `Full machine access: OFF. Allowed roots: ${workspaceRoots.join("; ")}. Tag this connector in ChatGPT before every task.`;
  const header = [
    "# Codex Local Coder MCP",
    `Default project: ${workspaceRoot}`,
    accessLine,
  ].join("\n");

  const footer = [
    "## Quick pointers",
    `Workspace roots: ${workspaceRoots.join("; ")}`,
    "agent_status — full tool cheat sheet + apply_patch format",
    "project_context(path, query) — compact project map or task-relevant instruction bundle",
  ].join("\n");

  const body = contextBlock?.trim();
  if (!body) return `${header}\n\n${REQUIREMENT_ASSURANCE_INSTRUCTIONS}\n\n${footer}`;
  return `${header}\n\n${REQUIREMENT_ASSURANCE_INSTRUCTIONS}\n\n${body}\n\n${footer}`;
}
