import fs from "fs";
import path from "path";
import { isBrowserUseEnabled, isComputerUseEnabled } from "./plugin-config.js";

export type ToolProfileName = "full" | "slim";

export const LOCAL_TOOL_CATALOG = [
  "read_text_file", "read_file_base64", "file_info", "write_file", "write_file_base64", "save_chatgpt_file", "edit_file", "multi_edit", "apply_patch",
  "glob", "grep", "code_intelligence", "list_directory", "directory_tree", "search_files", "create_directory", "delete_file", "delete_directory",
  "copy_file", "move_file", "replace_regex", "list_allowed_directories",
  "run_command", "shell_status", "shell_reset", "start_process", "process_status", "process_output", "process_input", "stop_process", "clear_processes",
  "node_repl", "ponytail_turn",
  "open_image", "render_svg", "capture_webpage", "visual_review",
  "goal", "task_state", "task_create", "task_status", "task_update", "task_complete", "task_list", "recovery_submit", "recovery_status",
  "browser_open", "browser_action", "browser_close",
  "computer_use", "browser_use_exec", "browser_use_screenshot",
  "git_status", "git_diff", "git_log", "git_add", "git_commit", "git_branch", "git_checkout", "git_restore", "git_stash",
  "git_reset", "git_pull", "git_push",
  "agent_status", "project_context", "remember", "load_path_rules", "route_skills", "list_skills", "load_skill", "install_skill", "uninstall_skill", "set_skill_enabled", "rewind",
  "mcp_servers", "mcp_tools", "mcp_call",
];

interface LocalToolOverrides {
  enabled?: string[];
  disabled?: string[];
}

const overridesPath = () => path.resolve(process.cwd(), "profiles", "tool-overrides.json");

export function getLocalToolOverrides(): LocalToolOverrides {
  try {
    return JSON.parse(fs.readFileSync(overridesPath(), "utf-8")) as LocalToolOverrides;
  } catch {
    return {};
  }
}

export function saveLocalToolOverrides(next: LocalToolOverrides): void {
  fs.mkdirSync(path.dirname(overridesPath()), { recursive: true });
  fs.writeFileSync(overridesPath(), JSON.stringify(next, null, 2));
}

/** Core tools for ChatGPT web — smaller tools/list payload, fewer discovery errors. */
export const SLIM_CHATGPT_TOOLS = new Set([
  "read_text_file",
  "read_file_base64",
  "file_info",
  "write_file",
  "write_file_base64",
  "save_chatgpt_file",
  "apply_patch",
  "glob",
  "grep",
  "code_intelligence",
  "list_directory",
  "run_command",
  "start_process",
  "process_status",
  "process_output",
  "process_input",
  "stop_process",
  "git_status",
  "git_diff",
  "agent_status",
  "project_context",
  "remember",
  "route_skills",
  "list_skills",
  "load_skill",
  "install_skill",
  "uninstall_skill",
  "set_skill_enabled",
  "goal",
  "task_state",
  "recovery_submit",
  "recovery_status",
  "visual_review",
  "rewind",
]);

export function getChatGptToolProfile(): ToolProfileName {
  const raw = (process.env.CHATGPT_TOOL_PROFILE || "slim").trim().toLowerCase();
  return raw === "full" ? "full" : "slim";
}

export function shouldExposeTool(name: string, profile: ToolProfileName = getChatGptToolProfile()): boolean {
  const overrides = getLocalToolOverrides();
  if ((overrides.disabled ?? []).includes(name)) return false;
  if (name === "computer_use") return isComputerUseEnabled();
  if (name === "browser_use_exec" || name === "browser_use_screenshot") return isBrowserUseEnabled();
  if (profile === "full") return true;
  return SLIM_CHATGPT_TOOLS.has(name) || (overrides.enabled ?? []).includes(name);
}
