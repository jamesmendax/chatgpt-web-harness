import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { markNativeDispatchStarted, markNativePreDispatchFailure } from "./runtime-scope.js";

const MAX_OUTPUT_BYTES = 18 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type ComputerTarget =
  | { kind: "desktop" }
  | { kind: "window"; hwnd: string; title?: string };

export interface ComputerUseRequest extends Record<string, unknown> {
  action: string;
  target?: "desktop" | "window";
  hwnd?: string;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  delta_x?: number;
  delta_y?: number;
  button?: "left" | "right" | "middle";
  text?: string;
  replace_existing?: boolean;
  keys?: string[];
  duration_ms?: number;
  timeout_ms?: number;
  confirmed?: boolean;
}

export interface CapabilityRecord {
  schema_version: number;
  provider: string;
  account_id: string;
  instance_id: string;
  token: string;
  issued_at: string;
  expires_at: string;
  helper_sha256: string;
}

interface HelperResponse {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Computer Use provider is not provisioned: ${name} is missing`);
  return value;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Shared by dispatch and health: the materialized expiry is authoritative. */
export function readComputerUseCapability(): CapabilityRecord {
  if (process.platform !== "win32") throw new Error("Computer Use is available only on Windows");
  const file = path.resolve(requiredEnv("HARNESS_COMPUTER_USE_CAPABILITY_FILE"));
  const helper = path.resolve(requiredEnv("HARNESS_COMPUTER_USE_HELPER"));
  const expectedHash = requiredEnv("HARNESS_COMPUTER_USE_HELPER_SHA256").toLowerCase();
  if (!fs.statSync(file).isFile() || !fs.statSync(helper).isFile()) throw new Error("Computer Use provider files are incomplete");
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as CapabilityRecord;
  if (record.schema_version !== 1 || record.provider !== "computer-use") throw new Error("Computer Use capability has an unsupported schema");
  if (!secureEqual(record.token, requiredEnv("HARNESS_COMPUTER_USE_TOKEN"))) throw new Error("Computer Use capability token mismatch");
  if (!secureEqual(record.instance_id, requiredEnv("HARNESS_COMPUTER_USE_INSTANCE_ID"))) throw new Error("Computer Use capability instance mismatch");
  if (process.env.HARNESS_ACCOUNT_ID && record.account_id !== process.env.HARNESS_ACCOUNT_ID) throw new Error("Computer Use capability account mismatch");
  if (!Number.isFinite(Date.parse(record.expires_at)) || Date.parse(record.expires_at) <= Date.now()) throw new Error("Computer Use capability expired; Desktop renewal is unavailable or overdue");
  if (!secureEqual(record.helper_sha256.toLowerCase(), expectedHash) || !secureEqual(sha256File(helper), expectedHash)) throw new Error("Computer Use helper integrity check failed");
  return record;
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function boundedJsonLine(value: unknown): string {
  const line = JSON.stringify(value);
  return line.length <= 16_384 ? line : JSON.stringify({ truncated: true });
}

function auditArguments(request: ComputerUseRequest): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...request };
  delete copy.confirmed;
  if (typeof request.text === "string") {
    copy.text = {
      redacted: true,
      chars: request.text.length,
      sha256: crypto.createHash("sha256").update(request.text).digest("hex"),
    };
  }
  return copy;
}

function highImpactKeypress(keys: string[]): boolean {
  const normalized = keys.map((key) => key.trim().toUpperCase())
    .map((key) => key === "CONTROL" ? "CTRL" : key).filter(Boolean);
  const set = new Set(normalized);
  return (
    (set.has("ALT") && set.has("F4")) ||
    (set.has("CTRL") && set.has("W")) ||
    (set.has("CTRL") && set.has("SHIFT") && set.has("W")) ||
    (set.has("META") && set.has("L")) ||
    (set.has("WIN") && set.has("L")) ||
    (set.has("CTRL") && set.has("ALT") && set.has("DELETE"))
  );
}

function keysFrom(request: ComputerUseRequest): string[] {
  if (Array.isArray(request.keys)) return request.keys.map(String).filter(Boolean).slice(0, 8);
  const raw = typeof request.key === "string" ? request.key : "";
  return raw.split("+").map((part) => part.trim()).filter(Boolean).slice(0, 8);
}

export class ComputerUseProvider {
  private target: ComputerTarget | null = null;
  private readonly instanceId = crypto.randomUUID();
  private capabilityBinding: string | null = null;
  private selectionScope: string | null = null;
  private serial: Promise<void> = Promise.resolve();

  private validateCapability(): CapabilityRecord {
    return readComputerUseCapability();
  }

  private capabilityForAction(): CapabilityRecord {
    try {
      const capability = this.validateCapability();
      const binding = crypto.createHash("sha256").update(JSON.stringify([
        capability.account_id, capability.instance_id, capability.token,
        capability.issued_at, capability.helper_sha256,
      ])).digest("hex");
      if (this.capabilityBinding !== binding) this.target = null;
      this.capabilityBinding = binding;
      return capability;
    } catch (error) {
      // Repairing or rotating provisioning never restores an old selection.
      this.target = null;
      this.capabilityBinding = null;
      throw error;
    }
  }

  private audit(request: ComputerUseRequest, status: "ok" | "error", error?: string): void {
    const file = process.env.HARNESS_COMPUTER_USE_AUDIT_LOG?.trim();
    if (!file) return;
    const event = {
      at: new Date().toISOString(),
      provider: "computer-use",
      provider_instance_id: this.instanceId,
      runtime_pid: process.pid,
      action: request.action,
      target: this.target,
      arguments: auditArguments(request),
      status,
      ...(error ? { error: error.slice(0, 500) } : {}),
    };
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.appendFileSync(path.resolve(file), `${boundedJsonLine(event)}\n`, { encoding: "utf8", mode: 0o600 });
    } catch {
      // The action result remains authoritative; an unwritable audit path is
      // surfaced by provider status and packaged health checks.
    }
  }

  private async runHelper(request: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<HelperResponse> {
    const previousBinding = this.capabilityBinding;
    const capability = this.capabilityForAction();
    if (request.selected_target && previousBinding !== this.capabilityBinding) {
      throw new Error("Computer Use capability changed; select the target again before screenshots or input");
    }
    const helper = path.resolve(requiredEnv("HARNESS_COMPUTER_USE_HELPER"));
    const env: NodeJS.ProcessEnv = {
      SystemRoot: process.env.SystemRoot || "C:\\Windows",
      WINDIR: process.env.WINDIR || process.env.SystemRoot || "C:\\Windows",
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HARNESS_COMPUTER_USE_CAPABILITY_FILE: requiredEnv("HARNESS_COMPUTER_USE_CAPABILITY_FILE"),
      HARNESS_COMPUTER_USE_TOKEN: capability.token,
      HARNESS_COMPUTER_USE_INSTANCE_ID: capability.instance_id,
      HARNESS_COMPUTER_USE_HELPER_SHA256: capability.helper_sha256,
      HARNESS_ACCOUNT_ID: capability.account_id,
    };
    return new Promise<HelperResponse>((resolve, reject) => {
      const child = spawn(powershellPath(), [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: HelperResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result!);
      };
      const collect = (bucket: Buffer[], chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          try { child.kill("SIGKILL"); } catch {}
          finish(new Error(`Computer Use helper output exceeded ${MAX_OUTPUT_BYTES} bytes`));
          return;
        }
        bucket.push(Buffer.from(chunk));
      };
      child.stdout.on("data", (chunk) => collect(stdout, chunk));
      child.stderr.on("data", (chunk) => collect(stderr, chunk));
      child.on("error", (error) => finish(error));
      child.on("exit", (code) => {
        if (settled) return;
        const out = Buffer.concat(stdout).toString("utf8").replace(/^\uFEFF/, "").trim();
        const err = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0 && !out) return finish(new Error(`Computer Use helper exited ${code}: ${err.slice(0, 1000)}`));
        try {
          const parsed = JSON.parse(out) as HelperResponse;
          if (!parsed.ok) return finish(new Error(parsed.error || "Computer Use helper rejected the action"));
          finish(undefined, parsed);
        } catch (error) {
          finish(new Error(`Computer Use helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}; ${err.slice(0, 500)}`));
        }
      });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finish(new Error(`Computer Use helper exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdin.end(JSON.stringify({
        ...request,
        token: capability.token,
        instance_id: capability.instance_id,
      }));
    });
  }

  execute(request: ComputerUseRequest, selectionScope = "direct-provider", signal?: AbortSignal, beforeDispatch?: () => Promise<void>): Promise<{ data: Record<string, unknown>; image?: Buffer }> {
    const snapshot = { ...request, ...(request.keys ? { keys: [...request.keys] } : {}) };
    const run = this.serial.then(() => this.executeQueued(snapshot, selectionScope, signal, beforeDispatch));
    // An error ends only that operation, not the queue; side effects are never replayed.
    this.serial = run.then(() => undefined, () => undefined);
    return run;
  }

  private async executeQueued(request: ComputerUseRequest, selectionScope: string, signal?: AbortSignal, beforeDispatch?: () => Promise<void>): Promise<{ data: Record<string, unknown>; image?: Buffer }> {
    const action = request.action;
    const dispatch = (input: Record<string, unknown>, timeoutMs?: number) => {
      // Helper entry is the conservative dispatch boundary. A helper/transport
      // error can never be relabeled as a local pre-dispatch rejection.
      markNativeDispatchStarted();
      return this.runHelper(input, timeoutMs);
    };
    try {
      try { await beforeDispatch?.(); }
      catch (error) { this.target = null; throw error; }
      if (signal?.aborted) {
        const error = new Error("Computer Use operation cancelled before native dispatch");
        error.name = "AbortError";
        throw error;
      }
      if (this.selectionScope !== selectionScope) this.target = null;
      this.selectionScope = selectionScope;
      const capability = this.capabilityForAction();
      if (action === "close") {
        this.target = null;
        this.audit(request, "ok");
        return { data: { closed: true, selected_target: null } };
      }

      if (action === "status") {
        const response = await dispatch({ action: "status" }, request.timeout_ms as number | undefined);
        const auditPath = process.env.HARNESS_COMPUTER_USE_AUDIT_LOG?.trim();
        const data = {
          provider: "harness-windows-native",
          protocol_version: 1,
          provider_instance_id: this.instanceId,
          runtime_pid: process.pid,
          selected_target: this.target,
          capability_expires_at: capability.expires_at,
          audit_log_writable: Boolean(auditPath && fs.existsSync(path.dirname(path.resolve(auditPath)))),
          ...(response.data ?? {}),
        };
        this.audit(request, "ok");
        return { data };
      }

      if (action === "list_windows") {
        const response = await dispatch({ action }, request.timeout_ms as number | undefined);
        this.audit(request, "ok");
        return { data: response.data ?? {} };
      }

      if (action === "select_target") {
        // An unsuccessful retarget must not silently keep acting on the old window.
        this.target = null;
        if (request.target === "desktop") {
          const response = await dispatch({ action: "status" }, request.timeout_ms as number | undefined);
          this.target = { kind: "desktop" };
          this.audit(request, "ok");
          return { data: { selected_target: this.target, ...(response.data ?? {}) } };
        }
        const hwnd = String(request.hwnd || "").trim();
        if (request.target !== "window" || !/^\d{1,20}$/.test(hwnd)) throw new Error("select_target requires target=desktop or target=window with a decimal hwnd from list_windows");
        const response = await dispatch({ action: "window_info", hwnd }, request.timeout_ms as number | undefined);
        const title = typeof response.data?.title === "string" ? response.data.title : undefined;
        this.target = { kind: "window", hwnd, ...(title ? { title } : {}) };
        this.audit(request, "ok");
        return { data: { selected_target: this.target, ...(response.data ?? {}) } };
      }

      if (!this.target) throw new Error("Select desktop or a window with select_target before screenshots or input");
      const keys = action === "keypress" ? keysFrom(request) : undefined;
      if (action === "keypress" && (!keys?.length)) throw new Error("keypress requires keys or a key chord");
      if (keys && highImpactKeypress(keys) && request.confirmed !== true) {
        throw new Error("This key chord can close or lock the active target; repeat with confirmed=true after explicit user confirmation");
      }
      const response = await dispatch({
        ...request,
        ...(keys ? { keys } : {}),
        selected_target: this.target,
      }, request.timeout_ms as number | undefined);
      const data: Record<string, unknown> = { ...(response.data ?? {}), selected_target: this.target };
      let image: Buffer | undefined;
      if (action === "screenshot") {
        const encoded = typeof data.image_base64 === "string" ? data.image_base64 : "";
        delete data.image_base64;
        image = Buffer.from(encoded, "base64");
        if (!image.length || image.length > 12 * 1024 * 1024) throw new Error("Computer Use screenshot is empty or exceeds 12 MiB");
      }
      this.audit(request, "ok");
      return { data, image };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit(request, "error", message);
      markNativePreDispatchFailure(error);
      throw error;
    }
  }
}
