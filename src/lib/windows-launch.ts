import fs from "node:fs";
import path from "node:path";

export interface LaunchSpec {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

// Characters cmd.exe interprets; each is escaped with ^ outside quotes.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

// Quote one argument so cmd.exe and the C runtime both hand it over unchanged
// (same rules as cross-spawn, MIT). npm-style .cmd shims re-parse their
// arguments once more, so their metacharacters are escaped twice.
function escapeCmdArgument(value: string, doubleEscape: boolean): string {
  let arg = String(value);
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
  arg = `"${arg}"`.replace(CMD_META, "^$1");
  return doubleEscape ? arg.replace(CMD_META, "^$1") : arg;
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT || env.PathExt || ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith("."));
}

function envPath(env: NodeJS.ProcessEnv): string {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  return key ? env[key] || "" : "";
}

function isFile(candidate: string): boolean {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

/** Resolve a program the way cmd.exe does: the current folder, then PATH, each with PATHEXT. */
export function resolveWindowsExecutable(executable: string, env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | null {
  const extensions = pathExtensions(env);
  const extension = path.win32.extname(executable).toLowerCase();
  // cmd.exe never runs an extensionless file: "npm" must find npm.cmd, not
  // npm's extensionless sh script in the same folder.
  const candidatesFor = (base: string): string[] => extension && extensions.includes(extension)
    ? [base]
    : [...extensions.map((ext) => base + ext), ...(extension ? [base] : [])];
  const hasDirectory = /[\\/]/.test(executable) || path.win32.isAbsolute(executable);
  const bases = hasDirectory
    ? [path.win32.resolve(cwd, executable)]
    : [cwd, ...envPath(env).split(";").map((dir) => dir.trim().replace(/^"|"$/g, "")).filter(Boolean)].map((dir) => path.win32.join(dir, executable));
  for (const base of bases) {
    for (const candidate of candidatesFor(base)) if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Exact-argv launch on Windows. libuv only tries .com/.exe, so `npm`/`yarn`
 * (.cmd shims) were ENOENT, and Node refuses .cmd/.bat with shell:false
 * (EINVAL, CVE-2024-27980). Resolve through PATHEXT and run batch files via
 * cmd.exe with each argument quoted so it arrives unchanged. Other platforms
 * and real executables are returned as given.
 */
export function windowsLaunch(executable: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): LaunchSpec {
  if (process.platform !== "win32") return { file: executable, args: [...args] };
  const resolved = resolveWindowsExecutable(executable, env, cwd);
  if (!resolved || !/\.(?:cmd|bat)$/i.test(resolved)) return { file: resolved ?? executable, args: [...args] };
  const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
  const line = [escapeCmdCommand(path.win32.normalize(resolved)), ...args.map((arg) => escapeCmdArgument(arg, shim))].join(" ");
  const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
