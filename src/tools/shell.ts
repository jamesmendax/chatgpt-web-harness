import { spawn } from "child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath } from "../lib/path-security.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import { compactOutput, observeCommand } from "../lib/command-observation.js";
import { childProcessEnv } from "../lib/child-env.js";
import { toSpillRef } from "../lib/spill.js";
import { getRuntimeScope } from "../lib/runtime-scope.js";
import { reconcileManagedProcessEffect, type ProcessEffectReference } from "../lib/goal-effect-scope.js";
import { synchronousCommandBudget, withSynchronousCommandSlot } from "../lib/transport-resilience.js";
import {
  captureProcessScope,
  getProcessJournalRecord,
  listProcessJournalRecords,
  processCommandHash,
  processScopeKind,
  processScopeMatches,
  readProcessLogPage,
  readProcessStartIdentity,
  upsertProcessJournalRecord,
  verifyRecoveredProcessIdentity,
  type CapturedProcessScope,
  type ProcessJournalRecord,
} from "../lib/process-journal.js";
import {
  processControlAvailable,
  processControlPaths,
  readProcessHostState,
  readTextTail,
  sendProcessControl,
  sweepFinishedProcessFolders,
  waitForProcessHostState,
  waitForProcessHostExit,
  writeProcessHostSpec,
  type ProcessHostState,
} from "../lib/process-control.js";
import { registerRuntimeStatusProvider } from "../lib/runtime-status-registry.js";
import {
  captureVerificationLaunchSnapshots,
  captureVerificationSnapshots,
  type GoalVerification,
  verificationDigest,
} from "../lib/goal-verification.js";
import { getGoal } from "../lib/goals.js";
import {
  bootstrapShellSession,
  createCommandLogPath,
  execInShellSession,
  execArgvInShellSession,
  getShellStatus,
  resetShellSession,
  getWinShell,
  transpileCompoundOperators,
  wrapPowerShellCommand,
} from "../lib/persistent-shell.js";

interface ManagedProcess {
  id: string;
  readonly processScope: CapturedProcessScope;
  command: string;
  cwd: string;
  startedAt: string;
  pid: number;
  hostPid: number;
  exitCode: number | null;
  signal: string | null;
  stdoutChars: number;
  stderrChars: number;
  fullOutputPath: string;
  stdoutPath: string;
  stderrPath: string;
  statePath: string;
  controlDir: string;
  processStartIdentity: string | null;
  hostStartIdentity: string | null;
  effectBinding?: ProcessEffectReference;
  journalPersisted: boolean;
  lastState: ProcessHostState;
  verificationFinalized: boolean;
  verificationCriteria: readonly { verification?: GoalVerification }[];
  verificationLaunchSnapshots: Readonly<Record<string, string | number | boolean | null>>;
  verificationCompletionSnapshots: Record<string, string | number | boolean | null>;
  verificationCompletion: Promise<void>;
}

const processes = new Map<string, ManagedProcess>();
const MAX_LOG_CHARS = 400_000;
const MAX_PROCESS_RECORDS = 32;
const FINISHED_PROCESS_TTL_MS = 30 * 60 * 1000;

function compactShellResult(
  result: Awaited<ReturnType<typeof execInShellSession>>,
  outputMode: "compact" | "full" | "none",
  outputChars: number
) {
  const observation = observeCommand({
    command: result.command,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exit_code,
    timedOut: result.timed_out,
  });
  if (outputMode === "full") return { ...result, ...observation };
  if (outputMode === "none") {
    return { ...result, stdout: "", stderr: "", ...observation };
  }

  const hasStdout = Boolean(result.stdout.trim());
  const hasStderr = Boolean(result.stderr.trim());
  const stdoutBudget = hasStdout && !hasStderr ? outputChars : hasStdout ? Math.max(1000, Math.floor(outputChars * 0.55)) : 500;
  const stderrBudget = hasStderr && !hasStdout ? outputChars : hasStderr ? Math.max(1000, outputChars - stdoutBudget) : 500;
  const stdout = compactOutput(result.stdout, stdoutBudget);
  const stderr = compactOutput(result.stderr, stderrBudget);
  return {
    ...result,
    stdout: stdout.text,
    stderr: stderr.text,
    output_preview_chars: stdout.text.length + stderr.text.length,
    output_omitted_chars: stdout.omitted_chars + stderr.omitted_chars,
    output_truncated: stdout.truncated || stderr.truncated || result.stdout_truncated || result.stderr_truncated,
    ...observation,
  };
}

function managedProcessScopeMatches(item: ManagedProcess, scope: CapturedProcessScope): boolean {
  const normalize = (root: string) => process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  return normalize(item.processScope.workspace_root) === normalize(scope.workspace_root)
    && processScopeMatches(item.processScope, scope);
}

function requireProcessScope(scope: CapturedProcessScope): void {
  if (scope.scope_kind === "unknown") throw new Error("PROCESS_SCOPE_REQUIRED: a trusted Goal or MCP session is required");
}

function requireProcessAccess(item: ManagedProcess | undefined, recovered: ProcessJournalRecord | null, scope: CapturedProcessScope): void {
  requireProcessScope(scope);
  const owner = item?.processScope ?? recovered;
  if (!owner) throw new Error("PROCESS_NOT_FOUND");
  if (processScopeKind(owner) === "unknown") throw new Error("PROCESS_OWNER_UNKNOWN: legacy process references cannot authorize logs or control");
  if (item ? !managedProcessScopeMatches(item, scope) : !processScopeMatches(owner, scope)) {
    throw new Error("PROCESS_OWNER_SCOPE_MISMATCH: process belongs to a different Goal or session");
  }
}

function processOwnershipMetadata(owner: CapturedProcessScope | ProcessJournalRecord) {
  return {
    scope_kind: processScopeKind(owner),
    goal_id: owner.goal_id ?? null,
    owner_session_id: owner.owner_session_id ?? null,
  };
}

function pruneFinishedProcesses(scope?: CapturedProcessScope): number {
  const now = Date.now();
  let cleared = 0;
  for (const [id, item] of processes) {
    if (scope && !managedProcessScopeMatches(item, scope)) continue;
    const finished = item.exitCode !== null || item.signal !== null;
    const ageMs = now - Date.parse(item.startedAt);
    if (finished && ageMs > FINISHED_PROCESS_TTL_MS) {
      processes.delete(id);
      cleared++;
    }
  }

  if (processes.size > MAX_PROCESS_RECORDS) {
    const finished = [...processes.values()]
      .filter((item) => (!scope || managedProcessScopeMatches(item, scope)) && (item.exitCode !== null || item.signal !== null))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const item of finished) {
      if (processes.size <= MAX_PROCESS_RECORDS) break;
      processes.delete(item.id);
      cleared++;
    }
  }
  return cleared;
}

async function activeVerificationCriteria(workspaceRoot: string): Promise<readonly { verification?: GoalVerification }[]> {
  try {
    const goal = await getGoal(workspaceRoot);
    return goal?.status === "active" ? goal.success_criteria.map((criterion) => ({ verification: criterion.verification })) : [];
  } catch {
    return [];
  }
}

function commandVerificationMetadata(
  tool: string,
  command: string,
  cwd: string,
  exitCode: number | null,
  running: boolean,
  ok: boolean,
): Record<string, string | number | boolean | null> {
  return {
    tool,
    commandHash: verificationDigest(command.trim()),
    cwd,
    exitCode,
    running,
    ok,
  };
}

async function completeManagedProcessVerification(item: ManagedProcess): Promise<void> {
  if (!item.verificationCriteria.length || item.exitCode !== 0 || item.signal !== null) return;
  const metadata = commandVerificationMetadata(
    "start_process",
    item.command,
    item.cwd,
    item.exitCode,
    false,
    true,
  );
  const snapshots = await captureVerificationSnapshots(
    item.verificationCriteria,
    metadata,
    item.verificationLaunchSnapshots,
  );
  Object.assign(item.verificationCompletionSnapshots, snapshots);
}

async function waitForCompletedProcessVerification(item: ManagedProcess): Promise<void> {
  if (item.exitCode !== null || item.signal !== null) await item.verificationCompletion;
}

function journalRecord(item: ManagedProcess): ProcessJournalRecord | null {
  return {
    id: item.id,
    ...processOwnershipMetadata(item.processScope),
    pid: item.pid,
    command_hash: processCommandHash(item.command),
    cwd: item.cwd,
    started_at: item.startedAt,
    process_start_identity: item.processStartIdentity,
    full_output_path: item.fullOutputPath,
    stdout_path: item.stdoutPath,
    stderr_path: item.stderrPath,
    state_path: item.statePath,
    control_dir: item.controlDir,
    host_pid: item.hostPid,
    host_start_identity: item.hostStartIdentity,
    effect_binding: item.effectBinding,
    state: item.exitCode !== null || item.signal !== null ? "finished" : "running",
    exit_code: item.exitCode,
    signal: item.signal,
    updated_at: new Date().toISOString(),
  };
}

async function syncManagedProcessState(item: ManagedProcess): Promise<ProcessHostState> {
  const state = await readProcessHostState(item.statePath) ?? item.lastState;
  if (!state.running && item.effectBinding && item.processScope.goal_id) {
    await reconcileManagedProcessEffect(item.processScope.workspace_root, item.processScope.goal_id,
      item.processScope.owner_session_id, item.effectBinding.effect_token);
  }
  item.lastState = state;
  item.exitCode = state.exit_code;
  item.signal = state.signal;
  item.stdoutChars = state.stdout_bytes;
  item.stderrChars = state.stderr_bytes;
  if (!state.running && !item.verificationFinalized) {
    item.verificationFinalized = true;
    item.verificationCompletion = completeManagedProcessVerification(item).catch(() => undefined);
    await item.verificationCompletion;
  }
  return state;
}

async function persistManagedProcess(workspaceRoot: string, item: ManagedProcess): Promise<boolean> {
  const record = journalRecord(item);
  if (!record) return false;
  try {
    await upsertProcessJournalRecord(workspaceRoot, record, item.processScope);
    item.journalPersisted = true;
    return true;
  } catch (error) {
    console.warn(`[process-journal] persist failed for ${item.id}: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

async function reconcileRecoveredProcessEffect(record: ProcessJournalRecord, scope: CapturedProcessScope): Promise<void> {
  if (record.effect_binding && scope.goal_id && processScopeMatches(record, scope) &&
      record.owner_session_id === scope.owner_session_id) {
    // The advisory journal supplies only a lookup key. Settlement independently
    // checks the authoritative binding and host proof; PID/display state is irrelevant.
    await reconcileManagedProcessEffect(scope.workspace_root, scope.goal_id, scope.owner_session_id,
      record.effect_binding.effect_token);
  }
}

async function recoveredProcessView(record: ProcessJournalRecord, scope: CapturedProcessScope) {
  await reconcileRecoveredProcessEffect(record, scope);
  const hostState = await readProcessHostState(record.state_path);
  const effectiveFinished = hostState ? !hostState.running : record.state === "finished";
  const identity = effectiveFinished ? "different_or_gone" : await verifyRecoveredProcessIdentity(record);
  const controlAvailable = processScopeMatches(record, scope) && !effectiveFinished && await processControlAvailable(record);
  return {
    id: record.id,
    ...processOwnershipMetadata(record),
    pid: record.pid,
    command: null,
    command_hash: record.command_hash,
    cwd: record.cwd,
    started_at: record.started_at,
    running: effectiveFinished ? false : identity === "same" ? true : identity === "different_or_gone" ? false : null,
    exit_code: hostState?.exit_code ?? record.exit_code,
    signal: hostState?.signal ?? record.signal,
    execution_mode: hostState?.execution_mode ?? null,
    output_encoding: hostState?.output_encoding ?? "utf-8",
    log_error: hostState?.log_error ?? null,
    stdout_chars: hostState?.stdout_bytes ?? null,
    stderr_chars: hostState?.stderr_bytes ?? null,
    full_output_path: record.full_output_path,
    recovered: true,
    process_identity: identity,
    control_available: controlAvailable,
    control_mode: controlAvailable ? "durable_host" : "observation_only",
  };
}

export function getManagedProcessRuntimeStatus() {
  pruneFinishedProcesses();
  const values = [...processes.values()];
  return {
    records: values.length,
    running: values.filter((item) => item.exitCode === null && item.signal === null).length,
    finished_retained: values.filter((item) => item.exitCode !== null || item.signal !== null).length,
    max_records: MAX_PROCESS_RECORDS,
    max_log_chars_per_stream: MAX_LOG_CHARS,
    control_mode: "durable_host",
    finished_ttl_ms: FINISHED_PROCESS_TTL_MS,
  };
}

type ProcessOutputView = "legacy" | "absolute" | "new" | "tail";

async function processLogOffset(filePath: string, view: ProcessOutputView, offset: number | undefined, maxBytes: number): Promise<number | undefined> {
  if (view === "legacy" && offset === undefined) return undefined;
  if (view === "tail") {
    const stat = await fs.stat(filePath);
    return Math.max(0, stat.size - maxBytes);
  }
  return offset ?? 0;
}

async function readSeparatedProcessOutput(stdoutPath: string | null | undefined, stderrPath: string | null | undefined, tailChars: number, encoding = "utf-8") {
  const maxBytes = Math.min(800_000, Math.max(4096, tailChars * 4));
  const [stdoutTail, stderrTail] = await Promise.all([
    readTextTail(stdoutPath, maxBytes, encoding),
    readTextTail(stderrPath, maxBytes, encoding),
  ]);
  return {
    rawStdout: stdoutTail.text.slice(-tailChars),
    rawStderr: stderrTail.text.slice(-tailChars),
    stdoutBytes: stdoutTail.bytes,
    stderrBytes: stderrTail.bytes,
  };
}

export function registerShellTools(server: McpServer, defaultCwd: string, timeoutSec: number): void {
  registerRuntimeStatusProvider("process", getManagedProcessRuntimeStatus);
  void bootstrapShellSession(defaultCwd);

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Run a PowerShell script directly on Windows (bash on other platforms), or provide executable and args for exact argv without shell expansion. Run short checks bounded to at most 90 seconds including queue time. For longer work use start_process once, retain its id/log path, and poll process_status/process_output. Never rerun a side effect just because result delivery failed. Cwd persists; use shell_status to inspect it.",
      inputSchema: {
        command: z.string().optional(),
        executable: z.string().min(1).optional(),
        args: z.array(z.string()).optional(),
        output_encoding: z.string().optional().default("utf-8").describe("External program output encoding, e.g. utf-8, gbk, cp936, utf-16le"),
        working_directory: z.string().optional().describe("One-off override; does not reset persistent cwd unless you use shell_reset"),
        output_mode: z.enum(["compact", "full", "none"]).optional().default("compact"),
        output_chars: z.number().int().min(1000).max(50000).optional().default(12000).describe("Output preview characters: 1000–50000; default 12000"),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command: shellCommand, executable, args, output_encoding, working_directory, output_mode, output_chars }) => {
      pruneFinishedProcesses();
      if ((shellCommand !== undefined) === (executable !== undefined) || (args !== undefined && !executable)) {
        return toolError("run_command", "Provide command OR executable with args, exclusively", {
          error_code: "COMMAND_INPUT_INVALID", outcome_kind: "needs_input", failure_phase: "validation",
          failure_step: "command_arguments", operation_started: false, may_have_partially_completed: false,
          retry_policy: "retry_with_changed_args",
        });
      }
      try { new TextDecoder(output_encoding.toLowerCase() === "cp936" ? "gbk" : output_encoding); }
      catch {
        return toolError("run_command", `Unsupported output encoding: ${output_encoding}`, {
          error_code: "COMMAND_INPUT_INVALID", outcome_kind: "needs_input", failure_phase: "validation",
          failure_step: "output_encoding", operation_started: false, may_have_partially_completed: false,
          retry_policy: "retry_with_changed_args",
        });
      }
      const command = shellCommand ?? JSON.stringify([executable, ...(args ?? [])]);
      requireCommandAllowed(command);
      const cwdOverride = working_directory ? await validatePath(working_directory) : undefined;
      const cwd = cwdOverride ?? (getShellStatus().cwd || defaultCwd);
      const verificationCriteria = await activeVerificationCriteria(defaultCwd);
      const verificationLaunchSnapshots = await captureVerificationLaunchSnapshots(
        verificationCriteria,
        commandVerificationMetadata("run_command", command, cwd, null, true, false),
      );
      const scope = getRuntimeScope();
      const localBudget = synchronousCommandBudget(timeoutSec * 1000, scope?.deadlineAt);
      if (localBudget <= 0 || scope?.signal?.aborted) {
        return toolResult("run_command", { error: "COMMAND_BUDGET_UNAVAILABLE", operation_started: false,
          error_code: "COMMAND_BUDGET_UNAVAILABLE", outcome_kind: "blocked", failure_phase: "admission",
          retryable: false, retry_policy: "refresh_state",
          remote_deadline_known: scope?.deadlineAt !== undefined }, { ok: false });
      }
      const result = await withSynchronousCommandSlot(
        (remainingMs) => executable !== undefined
          ? execArgvInShellSession(executable, args ?? [], defaultCwd, remainingMs, cwdOverride, output_encoding)
          : execInShellSession(command, defaultCwd, remainingMs, cwdOverride, output_encoding),
        localBudget, scope?.signal,
      );
      await audit({
        tool: "run_command",
        action: "command",
        target: result.cwd,
        status: result.exit_code === 0 ? "ok" : "error",
        details: { command, exit_code: result.exit_code },
      });
      const verificationCompletionSnapshots = await captureVerificationSnapshots(
        verificationCriteria,
        commandVerificationMetadata("run_command", result.command, result.cwd, result.exit_code, false, result.exit_code === 0),
        verificationLaunchSnapshots,
      );
      const compact = compactShellResult(result, output_mode, output_chars);
      const spill = await toSpillRef(compact.full_output_path);
      return toolResult("run_command", { ...compact, ...verificationCompletionSnapshots, ...(spill ? { spill } : {}),
        execution_budget_ms: localBudget, remote_deadline_known: scope?.deadlineAt !== undefined,
        ...(result.exit_code !== 0 ? {
          error_code: !result.operation_started ? "COMMAND_SPAWN_FAILED" : result.timed_out ? "COMMAND_TIMED_OUT" : result.exit_code === null ? "COMMAND_INTERRUPTED" : "COMMAND_EXIT_NONZERO",
          outcome_kind: "execution_error", failure_phase: "execution", failure_step: result.operation_started ? "command" : "spawn",
          operation_started: result.operation_started ?? false,
          may_have_partially_completed: result.operation_started ?? false,
          retryable: false, retry_policy: "inspect_original_result",
        } : {}),
        ...(result.timed_out ? { timeout_layer: "local_command_budget", recovery: "Inspect the log and artifacts before deciding whether a new managed job is needed. Do not assume a UI timeout or repeat completed side effects." } : {}),
      }, {
        ok: result.exit_code === 0,
        summary: `${compact.command_kind} ${compact.outcome}: exit ${result.exit_code} in ${result.cwd}`,
      });
    }
  );

  server.registerTool(
    "shell_status",
    {
      title: "Shell Status",
      description: "Show persistent shell session cwd and recent commands.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const status = getShellStatus();
      return toolResult("shell_status", status, { summary: `cwd: ${status.cwd}` });
    }
  );

  server.registerTool(
    "shell_reset",
    {
      title: "Shell Reset",
      description: "Reset persistent shell cwd to a directory (default: workspace).",
      inputSchema: { path: z.string().optional() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      const cwd = dirPath ? await validatePath(dirPath) : defaultCwd;
      resetShellSession(cwd);
      return toolResult("shell_reset", { cwd }, { summary: `shell cwd reset to ${cwd}` });
    }
  );

  server.registerTool(
    "start_process",
    {
      description: "Start a durable background PowerShell script (bash on other platforms), or executable with exact args; observe or control it with process tools.",
      inputSchema: { command: z.string().optional(), executable: z.string().min(1).optional(), args: z.array(z.string()).optional(), output_encoding: z.string().optional().default("utf-8"), working_directory: z.string().optional() },

      annotations: toolAnnotations("command"),
    },
    async ({ command: shellCommand, executable, args: argv, output_encoding, working_directory }) => {
      if ((shellCommand !== undefined) === (executable !== undefined) || (argv !== undefined && !executable)) {
        return toolError("start_process", "Provide command OR executable with args, exclusively", {
          error_code: "COMMAND_INPUT_INVALID", outcome_kind: "needs_input", failure_phase: "validation",
          failure_step: "command_arguments", operation_started: false, may_have_partially_completed: false,
          retry_policy: "retry_with_changed_args",
        });
      }
      const encoding = output_encoding.toLowerCase() === "cp936" ? "gbk" : output_encoding;
      try { new TextDecoder(encoding); }
      catch {
        return toolError("start_process", `Unsupported output encoding: ${output_encoding}`, {
          error_code: "COMMAND_INPUT_INVALID", outcome_kind: "needs_input", failure_phase: "validation",
          failure_step: "output_encoding", operation_started: false, may_have_partially_completed: false,
          retry_policy: "retry_with_changed_args",
        });
      }
      const command = shellCommand ?? JSON.stringify([executable, ...(argv ?? [])]);
      const processScope = captureProcessScope(defaultCwd);
      requireProcessScope(processScope);
      requireCommandAllowed(command);
      const cwd = working_directory ? await validatePath(working_directory) : getShellStatus().cwd || defaultCwd;
      const verificationCriteria = await activeVerificationCriteria(defaultCwd);
      const verificationLaunchSnapshots = await captureVerificationLaunchSnapshots(
        verificationCriteria,
        commandVerificationMetadata("start_process", command, cwd, null, true, false),
      );
      let shell = "bash";
      let effectiveCommand = command;
      let args = ["-lc", effectiveCommand];

      if (process.platform === "win32" && executable === undefined) {
        const winShellInfo = getWinShell();
        shell = winShellInfo.shell;
        if (!winShellInfo.isPwsh) {
          effectiveCommand = transpileCompoundOperators(command);
        }
        effectiveCommand = wrapPowerShellCommand(effectiveCommand, encoding);
        args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", effectiveCommand];
      }
      if (executable !== undefined) { shell = executable; args = argv ?? []; }

      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      void sweepFinishedProcessFolders(defaultCwd).catch(() => undefined);
      const fullOutputPath = createCommandLogPath(defaultCwd);
      if (!fullOutputPath) throw new Error("PROCESS_LOG_UNAVAILABLE: unable to reserve persistent command log");
      const control = processControlPaths(defaultCwd, id);
      const hostScript = fileURLToPath(new URL("../process-host.js", import.meta.url));
      await writeProcessHostSpec(control.spec, {
        version: 1,
        id,
        shell,
        args,
        cwd,
        full_output_path: fullOutputPath,
        stdout_path: control.stdout,
        stderr_path: control.stderr,
        state_path: control.state,
        control_dir: control.controlDir,
        output_encoding: encoding,
        execution_mode: executable === undefined ? "shell" : "argv",
      });
      const host = spawn(process.execPath, [hostScript, control.spec], {
        cwd,
        windowsHide: true,
        detached: true,
        stdio: "ignore",
        env: {
          ...childProcessEnv(),
          CI: "true",
          PAGER: "cat",
          GIT_PAGER: "cat",
          NO_COLOR: "1",
        },
      });
      // Spawn failures emit asynchronously even when no PID was assigned.
      host.once("error", () => undefined);
      if (!host.pid) {
        await fs.rm(control.spec, { force: true }).catch(() => undefined);
        return toolResult("start_process", {
          id, ...processOwnershipMetadata(processScope), error: "Process host did not start",
          error_code: "PROCESS_HOST_START_FAILED", outcome_kind: "execution_error",
          failure_phase: "execution", failure_step: "host_spawn", operation_started: false,
          may_have_partially_completed: false, retryable: false, retry_policy: "inspect_original_result",
          full_output_path: fullOutputPath,
        }, { ok: false });
      }
      host.unref();
      let hostState: ProcessHostState;
      try {
        // The host captures two bounded process-start identities before ACK.
        hostState = await waitForProcessHostState(control.state, 10_000);
      } catch (error) {
        // The host may already have started its child. Do not kill or launch a
        // replacement: retain enough paths and identity for later inspection.
        return toolResult("start_process", {
          id, ...processOwnershipMetadata(processScope), host_pid: host.pid, command, cwd,
          execution_mode: executable === undefined ? "shell" : "argv", output_encoding: encoding,
          full_output_path: fullOutputPath, stdout_path: control.stdout, stderr_path: control.stderr,
          state_path: control.state, control_dir: control.controlDir,
          error: String(error), error_code: "PROCESS_HOST_START_UNKNOWN", outcome_kind: "unknown",
          failure_phase: "execution", failure_step: "host_acknowledgement", operation_started: null,
          may_have_partially_completed: true, retryable: false, retry_policy: "inspect_original_result",
          recovery: "Inspect the original host state and logs; do not repeat the operation without determining its outcome.",
        }, { ok: false });
      }
      if (!hostState.child_pid) {
        // The host reported a definite launch failure (ENOENT, EINVAL): nothing ran.
        return toolResult("start_process", {
          id, ...processOwnershipMetadata(processScope), host_pid: host.pid, command, cwd,
          execution_mode: executable === undefined ? "shell" : "argv", output_encoding: encoding,
          full_output_path: fullOutputPath, error: hostState.spawn_error || "child process did not start",
          error_code: "PROCESS_SPAWN_FAILED", outcome_kind: "execution_error", failure_phase: "execution",
          failure_step: "spawn", operation_started: false, may_have_partially_completed: false,
          retryable: true, retry_policy: "retry_with_changed_args",
        }, { ok: false });
      }
      const [processStartIdentity, hostStartIdentity] = await Promise.all([
        hostState.child_start_identity === undefined ? readProcessStartIdentity(hostState.child_pid) : hostState.child_start_identity,
        hostState.host_start_identity === undefined ? readProcessStartIdentity(host.pid) : hostState.host_start_identity,
      ]);
      const item: ManagedProcess = {
        id,
        processScope,
        command,
        cwd,
        startedAt: hostState.started_at,
        pid: hostState.child_pid,
        hostPid: host.pid,
        exitCode: hostState.exit_code,
        signal: hostState.signal,
        stdoutChars: hostState.stdout_bytes,
        stderrChars: hostState.stderr_bytes,
        fullOutputPath,
        stdoutPath: control.stdout,
        stderrPath: control.stderr,
        statePath: control.state,
        controlDir: control.controlDir,
        processStartIdentity,
        hostStartIdentity,
        effectBinding: hostState.effect_binding,
        journalPersisted: false,
        lastState: hostState,
        verificationFinalized: false,
        verificationCriteria,
        verificationLaunchSnapshots,
        verificationCompletionSnapshots: {},
        verificationCompletion: Promise.resolve(),
      };
      processes.set(id, item);
      const journalPersisted = await persistManagedProcess(defaultCwd, item);
      await audit({ tool: "start_process", action: "start", target: cwd, status: "ok", details: { id, command } });
      const spill = await toSpillRef(item.fullOutputPath);
      return toolResult("start_process", {
        id,
        ...processOwnershipMetadata(processScope),
        pid: item.pid,
        host_pid: item.hostPid,
        command,
        execution_mode: executable === undefined ? "shell" : "argv",
        output_encoding: encoding,
        stdout_path: control.stdout,
        stderr_path: control.stderr,
        cwd,
        started_at: item.startedAt,
        full_output_path: item.fullOutputPath,
        process_start_identity: item.processStartIdentity,
        control_available: true,
        control_mode: "durable_host",
        recovery_journal_persisted: journalPersisted,
        ...(spill ? { spill } : {}),
      }, {
        summary: `started ${id}`,
      });
    }
  );

  server.registerTool(
    "process_status",
    {
      description: "Show status of background process(es).",
      inputSchema: { id: z.string().optional() },

      annotations: toolAnnotations("read"),
    },
    async ({ id }) => {
      const scope = captureProcessScope(defaultCwd);
      pruneFinishedProcesses(scope);
      const liveProcesses = await Promise.all([...processes.values()]
        .filter((p) => managedProcessScopeMatches(p, scope) && (!id || p.id === id))
        .map(async (p) => {
          const state = await syncManagedProcessState(p);
          if (!state.running) await persistManagedProcess(defaultCwd, p);
          return {
            id: p.id,
            ...processOwnershipMetadata(p.processScope),
            pid: p.pid,
            host_pid: p.hostPid,
            command: p.command,
            command_hash: processCommandHash(p.command),
            cwd: p.cwd,
            started_at: p.startedAt,
            running: state.running,
            exit_code: state.exit_code,
            signal: state.signal,
            execution_mode: state.execution_mode ?? null,
            output_encoding: state.output_encoding ?? "utf-8",
            log_error: state.log_error ?? null,
            stdout_chars: state.stdout_bytes,
            stderr_chars: state.stderr_bytes,
            stdin_open: state.stdin_open,
            full_output_path: p.fullOutputPath,
            recovered: false,
            process_identity: "durable_host_verified",
            control_available: state.running,
            control_mode: "durable_host",
            recovery_journal_persisted: p.journalPersisted,
            ...p.verificationCompletionSnapshots,
          };
        }));
      const liveIds = new Set(liveProcesses.map((item) => item.id));
      const journal = (await listProcessJournalRecords(defaultCwd, scope.goal_id ?? undefined))
        .filter((record) => (!id || record.id === id) && !liveIds.has(record.id)
          && (processScopeMatches(record, scope) || processScopeKind(record) === "unknown"));
      const recoveredProcesses = await Promise.all(journal.map((record) => recoveredProcessView(record, scope)));
      const processes_list = [...liveProcesses, ...recoveredProcesses];
      return toolResult("process_status", { processes: processes_list, recovered_records: recoveredProcesses.length }, { summary: `${processes_list.length} process(es)` });
    }
  );

  server.registerTool(
    "process_output",
    {
      description: "Read process logs with legacy, absolute, new, or tail cursor views.",
      inputSchema: {
        id: z.string(),
        tail_chars: z.number().int().positive().max(200000).optional().default(12000),
        output_mode: z.enum(["compact", "full", "none"]).optional().default("compact"),
        view: z.enum(["legacy", "absolute", "new", "tail"]).optional().default("legacy"),
        offset: z.number().int().nonnegative().optional().describe("Byte offset in the persistent combined command log; use next_offset to continue"),
        max_bytes: z.number().int().min(1024).max(200000).optional().default(12000).describe("Maximum bytes returned when offset paging is used"),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, tail_chars, output_mode, view, offset, max_bytes }) => {
      const scope = captureProcessScope(defaultCwd);
      pruneFinishedProcesses(scope);
      const item = processes.get(id);
      const recovered = item ? null : await getProcessJournalRecord(defaultCwd, id);
      if (!item && !recovered) throw new Error(`Unknown process id: ${id}`);
      requireProcessAccess(item, recovered, scope);
      const ownership = processOwnershipMetadata(item?.processScope ?? recovered!);

      let running: boolean | null;
      let exitCode: number | null;
      let signal: string | null;
      let stdoutChars: number | null;
      let stderrChars: number | null;
      let fullOutputPath: string | null;
      let stdoutPath: string | null | undefined;
      let stderrPath: string | null | undefined;
      let command: string | null;
      let commandHash: string;
      let cwd: string;
      let processIdentity: string;
      let controlAvailable: boolean;
      let completionSnapshots: Record<string, string | number | boolean | null> = {};

      if (item) {
        const state = await syncManagedProcessState(item);
        if (!state.running) await persistManagedProcess(defaultCwd, item);
        running = state.running;
        exitCode = state.exit_code;
        signal = state.signal;
        stdoutChars = state.stdout_bytes;
        stderrChars = state.stderr_bytes;
        fullOutputPath = item.fullOutputPath;
        stdoutPath = item.stdoutPath;
        stderrPath = item.stderrPath;
        command = item.command;
        commandHash = processCommandHash(item.command);
        cwd = item.cwd;
        processIdentity = "durable_host_verified";
        controlAvailable = state.running;
        completionSnapshots = item.verificationCompletionSnapshots;
      } else {
        await reconcileRecoveredProcessEffect(recovered!, scope);
        const hostState = await readProcessHostState(recovered!.state_path);
        const effectiveFinished = hostState ? !hostState.running : recovered!.state === "finished";
        const identity = effectiveFinished ? "different_or_gone" : await verifyRecoveredProcessIdentity(recovered!);
        running = effectiveFinished ? false : identity === "same" ? true : identity === "different_or_gone" ? false : null;
        exitCode = hostState?.exit_code ?? recovered!.exit_code;
        signal = hostState?.signal ?? recovered!.signal;
        stdoutChars = hostState?.stdout_bytes ?? null;
        stderrChars = hostState?.stderr_bytes ?? null;
        fullOutputPath = recovered!.full_output_path;
        stdoutPath = recovered!.stdout_path;
        stderrPath = recovered!.stderr_path;
        command = null;
        commandHash = recovered!.command_hash;
        cwd = recovered!.cwd;
        processIdentity = identity;
        controlAvailable = !effectiveFinished && await processControlAvailable(recovered!);
      }

      if (!fullOutputPath) {
        return toolResult("process_output", { id, ...ownership, recovered: !item, error: "PROCESS_LOG_UNAVAILABLE", command_hash: commandHash, control_available: controlAvailable }, { ok: false, summary: `process ${id} has no persistent log` });
      }

      const pageOffset = await processLogOffset(fullOutputPath, view, offset, max_bytes);
      if (pageOffset !== undefined) {
        const page = await readProcessLogPage(fullOutputPath, pageOffset, max_bytes);
        const spill = await toSpillRef(fullOutputPath);
        return toolResult("process_output", {
          id,
          ...ownership,
          command,
          command_hash: commandHash,
          cwd,
          running,
          exit_code: exitCode,
          signal,
          recovered: !item,
          process_identity: processIdentity,
          control_available: controlAvailable,
          control_mode: controlAvailable ? "durable_host" : "observation_only",
          full_output_path: fullOutputPath,
          output_format: "combined_command_log",
          cursor_mode: view === "legacy" ? "absolute" : view,
          log_page: page,
          ...(spill ? { spill } : {}),
          ...completionSnapshots,
        }, { summary: `paged output for ${id}` });
      }

      const outputState = item ? item.lastState : await readProcessHostState(recovered!.state_path);
      const separated = await readSeparatedProcessOutput(stdoutPath, stderrPath, tail_chars, outputState?.output_encoding);
      let rawStdout = separated.rawStdout;
      let rawStderr = separated.rawStderr;
      if (!stdoutPath && !stderrPath) {
        const combined = await readTextTail(fullOutputPath, Math.min(800_000, tail_chars * 4));
        rawStdout = combined.text.slice(-tail_chars);
        rawStderr = "";
      }
      const observation = command ? observeCommand({ command, stdout: rawStdout, stderr: rawStderr, exitCode }) : {};
      const stdout = output_mode === "full"
        ? rawStdout
        : output_mode === "none"
          ? ""
          : compactOutput(rawStdout, Math.max(1000, Math.floor(tail_chars * 0.55))).text;
      const stderr = output_mode === "full"
        ? rawStderr
        : output_mode === "none"
          ? ""
          : compactOutput(rawStderr, Math.max(1000, Math.floor(tail_chars * 0.45))).text;
      const data = {
        id,
        ...ownership,
        command,
        command_hash: commandHash,
        cwd,
        running,
        exit_code: exitCode,
        signal,
        stdout,
        stderr,
        output_encoding: outputState?.output_encoding ?? "utf-8",
        execution_mode: outputState?.execution_mode ?? null,
        log_error: outputState?.log_error ?? null,
        decode_anomaly: outputState?.decode_anomaly ?? false,
        raw_stdout_path: stdoutPath,
        raw_stderr_path: stderrPath,
        stdout_chars: stdoutChars ?? separated.stdoutBytes,
        stderr_chars: stderrChars ?? separated.stderrBytes,
        full_output_path: fullOutputPath,
        recovered: !item,
        process_identity: processIdentity,
        control_available: controlAvailable,
        control_mode: controlAvailable ? "durable_host" : "observation_only",
        ...completionSnapshots,
        ...observation,
      };
      const spill = await toSpillRef(fullOutputPath);
      return toolResult("process_output", { ...data, ...(spill ? { spill } : {}) }, { summary: `output for ${id}` });
    }
  );

  server.registerTool(
    "process_input",
    {
      description: "Write to managed process stdin; recovered control requires verified process identity.",
      inputSchema: {
        id: z.string(),
        text: z.string().max(100000).optional(),
        append_newline: z.boolean().optional(),
        close_stdin: z.boolean().optional(),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ id, text, append_newline, close_stdin }) => {
      const scope = captureProcessScope(defaultCwd);
      const item = processes.get(id);
      const recovered = item ? null : await getProcessJournalRecord(defaultCwd, id);
      if (!item && !recovered) throw new Error(`Unknown process id: ${id}`);
      requireProcessAccess(item, recovered, scope);
      const ownership = processOwnershipMetadata(item?.processScope ?? recovered!);
      let controlDir: string;
      let recoveredControl = false;
      if (item) {
        const state = await syncManagedProcessState(item);
        if (!state.running || !state.stdin_open) {
          return toolResult("process_input", { id, ...ownership, accepted: false, running: state.running, stdin_open: state.stdin_open }, { ok: false, summary: `${id} stdin is not writable` });
        }
        controlDir = item.controlDir;
      } else {
        recoveredControl = true;
        if (!recovered!.control_dir || !(await processControlAvailable(recovered!))) {
          return toolResult("process_input", { id, ...ownership, accepted: false, recovered: true, control_available: false, reason: "Recovered process host/child identity could not be proven." }, { ok: false, summary: `cannot write stdin for recovered process ${id}` });
        }
        controlDir = recovered!.control_dir;
      }
      const shouldClose = close_stdin === true;
      const payload = `${text ?? ""}${append_newline ? "\n" : ""}`;
      const receipt = await sendProcessControl(controlDir, "stdin", { text: payload, closeStdin: shouldClose });
      await audit({ tool: "process_input", action: "stdin", target: item?.cwd ?? recovered!.cwd, status: receipt.ok ? "ok" : "error", details: { id, bytes: Buffer.byteLength(payload), close_stdin: shouldClose } });
      return toolResult("process_input", { id, ...ownership, accepted: receipt.ok, recovered: recoveredControl, control_available: true, close_stdin: shouldClose, bytes: Buffer.byteLength(payload), ...(receipt.error ? { error: receipt.error } : {}) }, { ok: receipt.ok, summary: receipt.ok ? `stdin sent to ${id}` : `stdin failed for ${id}` });
    }
  );

  server.registerTool(
    "stop_process",
    {
      description: "Stop a background process by id.",
      inputSchema: { id: z.string(), force: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ id, force }) => {
      const scope = captureProcessScope(defaultCwd);
      const item = processes.get(id);
      if (!item) {
        const recovered = await getProcessJournalRecord(defaultCwd, id);
        if (!recovered) throw new Error(`Unknown process id: ${id}`);
        requireProcessAccess(undefined, recovered, scope);
        const ownership = processOwnershipMetadata(recovered);
        const hostState = await readProcessHostState(recovered.state_path);
        if (hostState && !hostState.running) {
          const terminal = recovered.state_path && recovered.host_pid
            ? await waitForProcessHostExit(recovered.state_path, recovered.host_pid, recovered.host_start_identity, 5000)
            : { state: hostState, host_exited: true };
          return toolResult("stop_process", {
            id,
            ...ownership,
            already_exited: true,
            recovered: true,
            exit_code: terminal.state?.exit_code ?? hostState.exit_code,
            signal: terminal.state?.signal ?? hostState.signal,
            host_released: terminal.host_exited,
          }, { summary: `${id} already exited` });
        }
        const identity = await verifyRecoveredProcessIdentity(recovered);
        if (!recovered.control_dir || !(await processControlAvailable(recovered))) {
          return toolResult("stop_process", {
            id,
            ...ownership,
            stopped: false,
            recovered: true,
            pid: recovered.pid,
            process_identity: identity,
            control_available: false,
            reason: "Recovered control is fail-closed unless both durable host and child start identities match the journal.",
          }, { ok: false, summary: `cannot safely stop recovered process ${id}` });
        }
        const receipt = await sendProcessControl(recovered.control_dir, "stop", { force });
        const terminal = receipt.ok && recovered.state_path && recovered.host_pid
          ? await waitForProcessHostExit(recovered.state_path, recovered.host_pid, recovered.host_start_identity, 5000)
          : null;
        await audit({ tool: "stop_process", action: "stop", target: recovered.cwd, status: receipt.ok ? "ok" : "error", details: { id, force, recovered: true } });
        return toolResult("stop_process", { id, ...ownership, stopped: receipt.ok, force, recovered: true, control_available: true,
          host_released: terminal?.host_exited ?? false, exit_code: terminal?.state?.exit_code ?? null, signal: terminal?.state?.signal ?? null,
          ...(receipt.error ? { error: receipt.error } : {}) }, { ok: receipt.ok, summary: receipt.ok ? `stop completed for recovered ${id}` : `stop failed for recovered ${id}` });
      }
      requireProcessAccess(item, null, scope);
      const ownership = processOwnershipMetadata(item.processScope);
      const state = await syncManagedProcessState(item);
      if (!state.running) {
        const terminal = await waitForProcessHostExit(item.statePath, item.hostPid, item.hostStartIdentity, 5000);
        return toolResult("stop_process", {
          id,
          ...ownership,
          already_exited: true,
          exit_code: terminal.state?.exit_code ?? state.exit_code,
          signal: terminal.state?.signal ?? state.signal,
          host_released: terminal.host_exited,
        }, { summary: `${id} already exited` });
      }
      const receipt = await sendProcessControl(item.controlDir, "stop", { force });
      const terminal = receipt.ok
        ? await waitForProcessHostExit(item.statePath, item.hostPid, item.hostStartIdentity, 5000)
        : null;
      if (terminal?.state) {
        item.lastState = terminal.state;
        item.exitCode = terminal.state.exit_code;
        item.signal = terminal.state.signal;
        await persistManagedProcess(defaultCwd, item);
      }
      await audit({ tool: "stop_process", action: "stop", target: item.cwd, status: receipt.ok ? "ok" : "error", details: { id, force } });
      return toolResult("stop_process", { id, ...ownership, stopped: receipt.ok, force, control_available: true,
        host_released: terminal?.host_exited ?? false, exit_code: terminal?.state?.exit_code ?? null, signal: terminal?.state?.signal ?? null,
        ...(receipt.error ? { error: receipt.error } : {}) }, { ok: receipt.ok, summary: receipt.ok ? `stop completed for ${id}` : `stop failed for ${id}` });
    }
  );

  server.registerTool(
    "clear_processes",
    {
      title: "Clear Finished Processes",
      description: "Remove finished process records from memory.",
      inputSchema: {},

      annotations: toolAnnotations("edit"),
    },
    async () => {
      const scope = captureProcessScope(defaultCwd);
      requireProcessScope(scope);
      let cleared = pruneFinishedProcesses(scope);
      for (const [id, item] of processes) {
        if (!managedProcessScopeMatches(item, scope)) continue;
        if (item.exitCode !== null || item.signal !== null) {
          processes.delete(id);
          cleared++;
        }
      }
      return toolResult("clear_processes", { cleared }, { summary: `cleared ${cleared}` });
    }
  );
}
