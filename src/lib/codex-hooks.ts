import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

type HookEvent = "session_start" | "user_prompt_submit" | "subagent_start";

export interface CodexHook {
  id: string;
  plugin: string;
  event: HookEvent;
  command: string;
  timeout_ms: number;
  status_message?: string;
  source_path: string;
  plugin_root: string;
  trusted: boolean;
  supported: boolean;
  enabled: boolean;
}

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const STATE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../profiles/codex-hooks.json");
const EVENT_MAP: Record<string, HookEvent | undefined> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
};

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function codexConfig(): Promise<{ enabledPlugins: Set<string>; trustedHooks: Set<string> }> {
  let text = "";
  try {
    text = await fs.readFile(path.join(CODEX_HOME, "config.toml"), "utf-8");
  } catch {
    return { enabledPlugins: new Set(), trustedHooks: new Set() };
  }
  const enabledPlugins = new Set<string>();
  for (const match of text.matchAll(/\[plugins\."([^"]+)"\]([\s\S]*?)(?=\r?\n\[|$)/g)) {
    if (/^enabled\s*=\s*true\s*$/m.test(match[2])) enabledPlugins.add(match[1]);
  }
  const trustedHooks = new Set(
    [...text.matchAll(/\[hooks\.state\."([^"]+)"\]/g)].map((match) => match[1])
  );
  return { enabledPlugins, trustedHooks };
}

async function latestPluginRoot(plugin: string): Promise<string | undefined> {
  const at = plugin.lastIndexOf("@");
  if (at <= 0) return undefined;
  const packageName = plugin.slice(0, at);
  const source = plugin.slice(at + 1);
  const base = path.join(CODEX_HOME, "plugins", "cache", source, packageName);
  try {
    const versions = (await fs.readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return versions.length ? path.join(base, versions[0]) : undefined;
  } catch {
    return undefined;
  }
}

export async function getCodexHooks(): Promise<CodexHook[]> {
  const { enabledPlugins, trustedHooks } = await codexConfig();
  const state = await readJson<{ enabled?: string[]; disabled?: string[] }>(STATE_PATH, {});
  const forcedEnabled = new Set(state.enabled ?? []);
  const forcedDisabled = new Set(state.disabled ?? []);
  const found: CodexHook[] = [];

  for (const plugin of enabledPlugins) {
    const pluginRoot = await latestPluginRoot(plugin);
    if (!pluginRoot) continue;
    const hooksDir = path.join(pluginRoot, "hooks");
    let manifests: string[] = [];
    try {
      manifests = (await fs.readdir(hooksDir))
        .filter((file) => file.endsWith(".json") && file.toLowerCase().includes("codex"));
    } catch {
      continue;
    }
    for (const manifestFile of manifests) {
      const sourcePath = path.join(hooksDir, manifestFile);
      const manifest = await readJson<{ hooks?: Record<string, Array<{ hooks?: Array<{ type?: string; command?: string; timeout?: number; statusMessage?: string }> }> > }>(sourcePath, {});
      for (const [eventName, groups] of Object.entries(manifest.hooks ?? {})) {
        const event = EVENT_MAP[eventName];
        if (!event) continue;
        for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
          for (let hookIndex = 0; hookIndex < (groups[groupIndex].hooks?.length ?? 0); hookIndex += 1) {
            const hook = groups[groupIndex].hooks![hookIndex];
            if (hook.type !== "command" || !hook.command) continue;
            const id = `${plugin}:hooks/${manifestFile}:${event}:${groupIndex}:${hookIndex}`;
            const trusted = trustedHooks.has(id);
            found.push({
              id,
              plugin,
              event,
              command: hook.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot),
              timeout_ms: Math.min(Math.max(1000, (hook.timeout ?? 5) * 1000), 15000),
              status_message: hook.statusMessage,
              source_path: sourcePath,
              plugin_root: pluginRoot,
              trusted,
              supported: event === "session_start",
              enabled: !forcedDisabled.has(id) && (forcedEnabled.has(id) || trusted),
            });
          }
        }
      }
    }
  }
  return found;
}

export async function saveCodexHooks(enabledIds: unknown): Promise<CodexHook[]> {
  const hooks = await getCodexHooks();
  const known = new Set(hooks.map((hook) => hook.id));
  const enabled = Array.isArray(enabledIds)
    ? [...new Set(enabledIds.filter((id): id is string => typeof id === "string" && known.has(id)))]
    : [];
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify({ enabled, disabled: hooks.map((hook) => hook.id).filter((id) => !enabled.includes(id)) }, null, 2) + "\n");
  return getCodexHooks();
}

function execute(command: string, timeoutMs: number, input?: string): Promise<string> {
  const shell = process.platform === "win32" ? "powershell.exe" : "bash";
  const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      windowsHide: true,
      env: { ...process.env, PLUGIN_DATA: CODEX_HOME },
    });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("");
    }, timeoutMs);
    child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout.trim());
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.stdin.end(input);
  });
}

function hookContext(output: string): string {
  try {
    const parsed = JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: unknown } };
    return typeof parsed.hookSpecificOutput?.additionalContext === "string"
      ? parsed.hookSpecificOutput.additionalContext
      : "";
  } catch {
    return output;
  }
}

export async function runCodexSessionStartHooks(): Promise<string> {
  const hooks = (await getCodexHooks()).filter((hook) => hook.enabled && hook.supported);
  const ponytail = hooks.find((hook) => hook.plugin === "ponytail@ponytail" && hook.event === "session_start");
  const output = await Promise.all(
    hooks
      .filter((hook) => hook !== ponytail)
      .map(async (hook) => hookContext(await execute(hook.command, hook.timeout_ms)))
  );
  if (ponytail) {
    output.push(
      "Ponytail controller is enabled. Before responding to each new user message, call ponytail_turn with the user's exact prompt. Apply only the active_instructions returned for that turn; when it reports mode off, do not apply any earlier Ponytail instructions."
    );
  }
  return output.filter(Boolean).join("\n\n").slice(0, 120_000);
}

export async function runCodexHook(hook: Pick<CodexHook, "command" | "timeout_ms">, input?: string): Promise<string> {
  return hookContext(await execute(hook.command, hook.timeout_ms, input));
}
