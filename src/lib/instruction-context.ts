import { CODEX_AGENT_PROMPT } from "./codex-agent-prompt.js";
import {
  collectGitSnapshot,
  formatEnvironmentForInstructions,
  formatGitSnapshotForInstructions,
  type GitSnapshot,
} from "./git-snapshot.js";
import {
  formatProjectMemoryForInstructions,
  loadProjectMemory,
  type ProjectMemoryBundle,
} from "./project-memory.js";
import { appendAutoMemory, formatAutoMemoryForInstructions, loadAutoMemory } from "./auto-memory.js";
import { formatSkillsForInstructions, loadProjectSkills } from "./skills-loader.js";
import { getChatGptToolProfile } from "./tool-profile.js";
import { buildServerInstructions } from "./quickstart.js";

export interface InstructionContextOptions {
  workspaceRoot: string;
  workspaceRoots: string[];
  pid: number;
  adminPort: number;
}

export interface InstructionContext {
  projectMemory: ProjectMemoryBundle;
  git: GitSnapshot;
  instructionsText: string;
  instructionBytes: number;
}

export async function buildInstructionContext(
  opts: InstructionContextOptions
): Promise<InstructionContext> {
  const profile = getChatGptToolProfile();
  const isWebSlim = profile === "slim";
  const [projectMemory, git, skills, autoMemory] = await Promise.all([
    loadProjectMemory(opts.workspaceRoot, {
      workspaceRoots: opts.workspaceRoots,
      maxBytes: isWebSlim ? 8_000 : undefined,
      maxLines: isWebSlim ? 100 : undefined,
    }),
    collectGitSnapshot(opts.workspaceRoot),
    loadProjectSkills(opts.workspaceRoot, { includeLayout: !isWebSlim }),
    loadAutoMemory(opts.workspaceRoot, isWebSlim ? { maxBytes: 4_000, maxLines: 40 } : undefined),
  ]);

  const blocks = [
    CODEX_AGENT_PROMPT,
    `Tool profile: **${profile}**.`,
    formatEnvironmentForInstructions({
      workspaceRoot: opts.workspaceRoot,
      workspaceRoots: opts.workspaceRoots,
      pid: opts.pid,
      adminPort: opts.adminPort,
      nodeVersion: process.version,
    }),
    formatGitSnapshotForInstructions(git),
    formatAutoMemoryForInstructions(autoMemory),
    projectMemory.sections.length ? formatProjectMemoryForInstructions(projectMemory) : "",
    isWebSlim
      ? `Enabled Skills: ${skills.filter(s => s.invocation_policy?.allow_implicit !== false).length}. For design, coding, testing, migration or other relevant user tasks, call route_skills with the current request summary and phase before implementing. It ranks enabled current-account Skills and loads the primary instructions; follow continuations and required references. The user need not name Skills. Respect disabled/manual_only, user constraints and project rules. Loading is not proof of application or verification.`
      : formatSkillsForInstructions(skills),
  ].filter(Boolean);

  const projectMemoryBlock = blocks.join("\n\n");
  const instructionsText = buildServerInstructions(
    opts.workspaceRoot,
    opts.workspaceRoots,
    true,
    projectMemoryBlock
  );

  return {
    projectMemory,
    git,
    instructionsText,
    instructionBytes: Buffer.byteLength(instructionsText, "utf-8"),
  };
}

export function summarizeInstructionContext(ctx: InstructionContext): Record<string, unknown> {
  return {
    root: ctx.projectMemory.root,
    workspace_roots: ctx.projectMemory.workspace_roots,
    memory_files: ctx.projectMemory.sections.map((s) => ({
      path: s.path,
      kind: s.kind,
      truncated: s.truncated,
    })),
    memory_bytes: ctx.projectMemory.total_bytes,
    instruction_bytes: ctx.instructionBytes,
    git: ctx.git.is_repo
      ? { branch: ctx.git.branch, commits: ctx.git.recent_commits?.length ?? 0 }
      : { is_repo: false },
    loaded_at: ctx.projectMemory.loaded_at,
    tool_profile: getChatGptToolProfile(),
  };
}

export { appendAutoMemory };