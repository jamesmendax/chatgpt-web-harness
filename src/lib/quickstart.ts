export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Requirement readiness applies to every task. Read-only discovery is allowed before READY; side effects require _intent with RRS >= 95 and zero blocking ambiguities.
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
- run_command: persistent shell (cd persists); full profile also exposes shell_status for explicit session inspection
- start_process: long-running commands; follow with process_status / process_output / process_input / stop_process
- visual_review: universal review for image/SVG/web/PDF/PPTX/DOCX with focus crops, diagnostics, comparison, and freshness tracking
- task_state: compact long-task checkpoint; tool calls automatically add failures, checks, and changed files while active
- full profile also contains experimental visual/browser/task tools; they stay hidden from ChatGPT web slim unless explicitly enabled
- git_status / git_diff: structured inspection; use run_command for commit, restore, branch, and other Git mutations
- rewind: action=list|preview|restore|status — undo file edits via automatic checkpoints
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
## Requirement readiness gate
This gate applies to every user task. Before any side-effecting tool call, first establish a Requirement Model with at least 95% execution readiness and zero blocking ambiguities. Do not turn this into a fixed quality rubric: irrelevant fields are N/A, and only unknowns that materially change execution, outcome, risk, or completion criteria count against readiness. Use read-only discovery freely to close uncertainty before asking the user.

Normal clarification is bounded: ask at most 5 high-value questions per round and at most 2 normal rounds. After round 2, do not keep asking normal questions; enter Resolution Stage using a low-risk recorded assumption, a user-delegated noncritical decision, a small forced choice, safe-prefix work, or a hard blocker only for key irreplaceable ambiguity whose wrong choice could be major/irreversible. "Do it directly" may delegate noncritical choices but never overrides a major irreversible blocker.

Side-effecting tools expose a reserved _intent string. Send compact JSON with this shape before the first side effect and keep the same intent_revision while the requirement meaning is unchanged:
{"intent_revision":1,"objective":"...","scope":["..."],"out_of_scope":[],"deliverables":[],"success_criteria":["..."],"constraints":[],"protected_resources":[],"known_facts":[],"assumptions":[],"delegated_decisions":[],"remaining_nonblocking_uncertainties":[],"closure_items":[],"ambiguities":[],"clarification_round":0,"questions_in_round":0,"resolution_mode":"none"}
closure_items, when needed: {"id":"...","status":"closed|open|na","materiality":"low|medium|high|critical","basis":"..."}. ambiguities: {"id":"...","question":"...","materiality":"low|medium|high|critical","reversible":true|false,"blocking":true|false,"delegated":true|false}. The runtime computes RRS; never pass merely by claiming a confidence percentage. If the user changes objective, scope, protection boundary, or completion criteria, increment intent_revision before any further side effect.

When available, the first result after full admission provides an accepted _intent reference and original expiry. Send its exact JSON string {"reference":{"intent_revision":1,"requirement_hash":"<full 64-character hash>"}} on subsequent side effects in the same account, workspace, session and Goal. The reference never extends expiry. If unavailable, expired, rejected, or the requirement changes, send the full current model again; do not rely on a shortened context hash.
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
