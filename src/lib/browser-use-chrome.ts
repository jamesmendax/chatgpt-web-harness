import path from "node:path";
import { execFile, spawnSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export interface ChromeNativeProcess {
  pid: number; parent_pid: number; created_at: string; executable: string; command_line: string;
}
export interface ChromeLaunchIdentity {
  launcher_pid: number; executable: string; profile: string; port: number; started_at_ms: number;
}
interface NativeSnapshot {
  processes: ChromeNativeProcess[];
  listeners: Array<{ pid: number; address: string }>;
}
const normalized = (value: string) => path.win32.resolve(value).toLowerCase().replace(/[\\/]+$/, "");
const positivePid = (value: number) => Number.isSafeInteger(value) && value > 0;

function switchValues(command: string, name: string): string[] {
  // Windows paths cannot contain double quotes. Accept Chrome's quoted whole
  // argument, quoted value, and unquoted forms; reject duplicate ownership flags.
  const expression = new RegExp('(?:^|\\s)(?:"--' + name + '=([^"]*)"|--' + name + '="([^"]*)"|--' + name + '=([^\\s"]+))(?=\\s|$)', "g");
  return [...command.matchAll(expression)].map(match => match[1] ?? match[2] ?? match[3]);
}

export function chromeProcessMatchesLaunch(process: ChromeNativeProcess, launch: ChromeLaunchIdentity): boolean {
  if (!positivePid(process.pid) || process.parent_pid !== launch.launcher_pid ||
      typeof process.executable !== "string" || normalized(process.executable) !== normalized(launch.executable) ||
      typeof process.command_line !== "string" || /(?:^|\s)"?--type(?:=|\s)/.test(process.command_line)) return false;
  const created = Date.parse(process.created_at);
  if (!Number.isFinite(created) || created < launch.started_at_ms - 250 || created > launch.started_at_ms + 25_000) return false;
  const profiles = switchValues(process.command_line, "user-data-dir");
  const ports = switchValues(process.command_line, "remote-debugging-port");
  return profiles.length === 1 && normalized(profiles[0]) === normalized(launch.profile) &&
    ports.length === 1 && ports[0] === String(launch.port);
}

export function selectReexecutedChrome(processes: ChromeNativeProcess[], launch: ChromeLaunchIdentity): ChromeNativeProcess | undefined {
  const matches = processes.filter(process => chromeProcessMatchesLaunch(process, launch));
  if (matches.length > 1) throw new Error("BROWSER_CHROME_IDENTITY_AMBIGUOUS: multiple children match this browser launch");
  return matches[0];
}

export function sameChromeProcess(current: ChromeNativeProcess, expected: ChromeNativeProcess, launch: ChromeLaunchIdentity): boolean {
  return current.pid === expected.pid && current.created_at === expected.created_at &&
    chromeProcessMatchesLaunch(current, launch);
}

function queryArguments(filter: { pid?: number; parentPid?: number; port?: number }): string[] {
  const pid = filter.pid ?? filter.parentPid;
  if (!positivePid(pid!)) throw new Error("Invalid owned Chrome process identity");
  if (filter.port !== undefined && (!Number.isInteger(filter.port) || filter.port < 1 || filter.port > 65535)) throw new Error("Invalid owned Chrome port");
  // Only numeric, validated identifiers enter PowerShell. Paths/command lines
  // are compared in JS and never interpolated into executable shell text.
  const clause = filter.pid ? "ProcessId" : "ParentProcessId";
  const query = "Get-CimInstance Win32_Process -Filter \"" + clause + " = " + pid + " AND Name = 'chrome.exe'\"";
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$rows=@(" + query + " | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;parent_pid=[int]$_.ParentProcessId;created_at=$_.CreationDate.ToUniversalTime().ToString('o');executable=[string]$_.ExecutablePath;command_line=[string]$_.CommandLine} })",
    "$listeners=@(" + (filter.port === undefined ? "" : "Get-NetTCPConnection -LocalPort " + filter.port + " -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{pid=[int]$_.OwningProcess;address=[string]$_.LocalAddress} }") + ")",
    "[pscustomobject]@{processes=$rows;listeners=$listeners} | ConvertTo-Json -Depth 4 -Compress",
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
function powershell(): string {
  return path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function parseSnapshot(output: string): NativeSnapshot {
  const value = JSON.parse(output.replace(/^\uFEFF/, "").trim()) as NativeSnapshot;
  if (!Array.isArray(value.processes) || !Array.isArray(value.listeners)) throw new Error("Invalid native Chrome ownership snapshot");
  return value;
}
async function snapshot(filter: { pid?: number; parentPid?: number; port?: number }): Promise<NativeSnapshot> {
  const result = await execFileAsync(powershell(), queryArguments(filter), { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024, encoding: "utf8" });
  return parseSnapshot(result.stdout);
}
function snapshotSync(filter: { pid?: number; parentPid?: number }): NativeSnapshot | undefined {
  const result = spawnSync(powershell(), queryArguments(filter), { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024, encoding: "utf8" });
  if (result.error || result.status !== 0) return undefined;
  try { return parseSnapshot(result.stdout); } catch { return undefined; }
}

/** CIM can retain an exited process object while another handle is open.
 * Confirm termination on a native handle only when it still names the same
 * creation identity. Failure or access denial remains unknown. */
export async function ownedChromeDefinitelyExited(identity: ChromeNativeProcess): Promise<boolean> {
  if (process.platform !== "win32" || !positivePid(identity.pid) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}0Z$/.test(identity.created_at)) return false;
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "Add-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic static class OwnedChromeExitProbe {\n [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);\n [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);\n [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint code);\n [DllImport(\"kernel32.dll\")] public static extern bool CloseHandle(IntPtr process);\n}\n'@",
    `$h=[OwnedChromeExitProbe]::OpenProcess(0x1000,$false,${identity.pid})`,
    "if($h -eq [IntPtr]::Zero){[Console]::Out.Write('unknown');exit 0}",
    "try { $c=[long]0;$e=[long]0;$k=[long]0;$u=[long]0;$code=[uint32]0",
    "if(-not [OwnedChromeExitProbe]::GetProcessTimes($h,[ref]$c,[ref]$e,[ref]$k,[ref]$u)){[Console]::Out.Write('unknown');exit 0}",
    "if(-not [OwnedChromeExitProbe]::GetExitCodeProcess($h,[ref]$code)){[Console]::Out.Write('unknown');exit 0}",
    // Win32_Process.CreationDate retains microseconds; native FILETIME adds
    // one 100ns digit. Compare precisely the WMI-representable six digits.
    `$expected='${identity.created_at.slice(0, 26)}'`,
    "$actual=[DateTime]::FromFileTimeUtc($c).ToString('o').Substring(0,26)",
    "if($actual -eq $expected -and $code -ne 259){[Console]::Out.Write('exited')}else{[Console]::Out.Write('unknown')}",
    "} finally { [OwnedChromeExitProbe]::CloseHandle($h)|Out-Null }",
  ].join("\n");
  try {
    const result = await execFileAsync(powershell(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8" });
    return result.stdout.trim() === "exited";
  } catch { return false; }
}

/** The launcher ChildProcess is diagnostic state, not necessarily the live
 * browser: Windows Chrome can exit 0 after starting an owned replacement root.
 * Adoption is restricted to its direct child, exact exe/profile/port and launch
 * window. CDP readiness additionally verifies the listening process identity. */
export class OwnedChromeProcess {
  private identity: ChromeNativeProcess | undefined;
  constructor(
    readonly launcher: ChildProcess,
    readonly launch: ChromeLaunchIdentity,
    private readonly track: (pid: number, confirm: () => number | undefined) => void,
    private readonly untrack: (pid: number) => void,
    private readonly kill: (pid: number) => void,
    private readonly definitelyExited: (identity: ChromeNativeProcess) => Promise<boolean> = ownedChromeDefinitelyExited,
  ) {
    this.track(launch.launcher_pid, () => {
      if (launcher.exitCode === null && launcher.signalCode === null) return launch.launcher_pid;
      if (process.platform !== "win32" || launcher.exitCode !== 0 || launcher.signalCode !== null) return undefined;
      const candidates = snapshotSync({ parentPid: launch.launcher_pid });
      return candidates ? selectReexecutedChrome(candidates.processes, launch)?.pid : undefined;
    });
  }
  get pid(): number { return this.identity?.pid ?? this.launch.launcher_pid; }
  get relaunched(): boolean { return Boolean(this.identity); }

  private adopt(identity: ChromeNativeProcess): void {
    this.identity = identity;
    this.untrack(this.launch.launcher_pid);
    this.track(identity.pid, () => {
      const current = snapshotSync({ pid: identity.pid })?.processes.find(process => process.pid === identity.pid);
      return current && sameChromeProcess(current, identity, this.launch) ? identity.pid : undefined;
    });
  }

  async refresh(): Promise<boolean> {
    if (this.identity) {
      const current = (await snapshot({ pid: this.identity.pid })).processes.find(process => process.pid === this.identity!.pid);
      return Boolean(current && sameChromeProcess(current, this.identity, this.launch));
    }
    if (this.launcher.exitCode === null && this.launcher.signalCode === null) return true;
    if (process.platform !== "win32" || this.launcher.exitCode !== 0 || this.launcher.signalCode !== null) return false;
    const candidate = selectReexecutedChrome((await snapshot({ parentPid: this.launch.launcher_pid })).processes, this.launch);
    if (!candidate) return false;
    this.adopt(candidate);
    return true;
  }

  async ownsListener(): Promise<boolean> {
    const pid = this.pid, identity = this.identity;
    const current = await snapshot({ pid, port: this.launch.port });
    const currentProcess = current.processes.find(item => item.pid === pid);
    const matches = currentProcess && (identity
      ? sameChromeProcess(currentProcess, identity, this.launch)
      : this.launcher.exitCode === null && this.launcher.signalCode === null &&
        chromeProcessMatchesLaunch(currentProcess, { ...this.launch, launcher_pid: process.pid }));
    return Boolean(matches &&
      current.listeners.some(listener => listener.pid === pid && ["127.0.0.1", "::1"].includes(listener.address)) &&
      current.listeners.every(listener => listener.pid === pid && ["127.0.0.1", "::1"].includes(listener.address)));
  }

  async close(): Promise<void> {
    // Also discover a replacement when startup failed before CDP was ready.
    const killed = new Set<string>();
    const deadline = Date.now() + 10_000;
    while (await this.refresh()) {
      const identity = this.pid + ":" + (this.identity?.created_at ?? "launcher");
      if (this.identity && killed.has(identity) && await this.definitelyExited(this.identity)) break;
      if (!killed.has(identity)) { this.kill(this.pid); killed.add(identity); }
      if (Date.now() >= deadline) {
        if (await this.refresh()) {
          const current = this.identity && (this.pid + ":" + this.identity.created_at);
          if (!current || !killed.has(current) || !(await this.definitelyExited(this.identity!))) {
            throw new Error("BROWSER_CHROME_CLOSE_INCOMPLETE: owned browser has not exited");
          }
        }
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.untrack(this.pid);
    this.untrack(this.launch.launcher_pid);
  }
}
