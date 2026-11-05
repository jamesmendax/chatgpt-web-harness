import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getRuntimeScope } from "./runtime-scope.js";
import { getLocalPluginsConfigPath } from "./plugin-config.js";
import { audit } from "./audit.js";
import type { ResolvedSkill, SkillInvocationMode } from "./skill-resolver.js";

type Range = [number, number];
interface Resource { relative_path: string; kind: string; size_bytes: number; file: string; root: string; root_identity: string }
interface Selection {
  id: string; binding: string; skill_id: string; content_sha256: string; mode: SkillInvocationMode;
  phase: string; created_at: string; invocation_id: string | null; goal_id: string | null;
  task_id: string | null;
  resources: Resource[]; coverage: Map<string, { sha256: string; total: number; ranges: Range[] }>;
  resolved_identity: string;
}
const selections = new Map<string, Selection>();
const TTL = 6 * 60 * 60 * 1000;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function binding(workspace: string): string {
  const scope = getRuntimeScope();
  return digest(JSON.stringify([path.resolve(getLocalPluginsConfigPath()), path.resolve(workspace),
    scope?.principalId ?? null, scope?.tunnelProfile ?? null, scope?.mcpSessionId ?? null,
    scope?.goalId ?? null, scope?.goalOwnerSessionId ?? null]));
}
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
async function resourcesFor(skill: ResolvedSkill): Promise<Resource[]> {
  const resources: Resource[] = [];
  const root = await fs.realpath(skill.dir);
  const rootStat = await fs.stat(root);
  const rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
  const visit = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || [".git", "node_modules"].includes(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && file !== path.join(root, "SKILL.md")) {
        const relative_path = path.relative(root, file).split(path.sep).join("/");
        resources.push({ relative_path, kind: relative_path.split("/")[0], size_bytes: (await fs.stat(file)).size, file, root, root_identity: rootIdentity });
      }
      if (resources.length > 10_000) throw new Error("SKILL_RESOURCE_LIMIT: split this oversized Skill package.");
    }
  };
  await visit(root);
  // Audited built-in documentation lives outside the Skill directory. Only
  // these concrete files get a mapping; callers never supply an outside path.
  if (skill.source === "computer-use" || skill.source === "browser-use") {
    const canonicalCodeRoot = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
    const providerRoot = path.join(canonicalCodeRoot, "bundled-plugins", skill.source);
    const expectedRoot = await fs.realpath(providerRoot);
    if (path.relative(providerRoot, expectedRoot) !== "") throw new Error("SKILL_PROVIDER_ROOT_LINKED");
    const actualSkill = await fs.realpath(skill.path);
    if (!inside(expectedRoot, actualSkill)) throw new Error("SKILL_PROVIDER_ROOT_INVALID");
    let docs: string;
    try { docs = await fs.realpath(path.join(providerRoot, "docs")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return resources; throw error; }
    if (!inside(expectedRoot, docs)) throw new Error("SKILL_PROVIDER_DOCS_OUTSIDE_ROOT");
    const docsStat = await fs.stat(docs);
    for (const name of ["guidance.md", "api.md", "confirmations.md", "provenance.md"]) {
      const file = path.join(docs, name);
      try {
        const st = await fs.lstat(file);
        if (st.isFile() && !st.isSymbolicLink()) resources.push({ relative_path: `@provider-docs/${name}`, kind: "provider-docs", size_bytes: st.size, file, root: docs, root_identity: `${docsStat.dev}:${docsStat.ino}` });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  return resources.sort((a, b) => a.relative_path.localeCompare(b.relative_path, "en"));
}
export async function selectSkillContent(workspace: string, skill: ResolvedSkill, mode: SkillInvocationMode,
  selectionId?: string, phase = "auto"): Promise<Selection> {
  const owner = binding(workspace);
  const scope = getRuntimeScope();
  let taskId: string | null = null;
  if (scope?.mcpSessionId) {
    try {
      const { getActiveTaskId, getDurableTask } = await import("./durable-tasks.js");
      const activeId = await getActiveTaskId(workspace, scope.mcpSessionId);
      if (activeId) {
        const task = await getDurableTask(workspace, activeId);
        if (task.status === "active" || task.status === "blocked") taskId = task.id;
      }
    } catch { /* Optional evidence context must not prevent a resource read. */ }
  }
  const realDir = await fs.realpath(skill.dir);
  const realFile = await fs.realpath(skill.path);
  const st = await fs.stat(realDir);
  const identity = JSON.stringify([path.resolve(skill.dir), path.resolve(skill.path), skill.source, realDir, realFile, st.dev, st.ino]);
  for (const [id, row] of selections) if (Date.now() - Date.parse(row.created_at) > TTL) selections.delete(id);
  if (selectionId) {
    const row = selections.get(selectionId);
    if (row && row.binding === owner && row.task_id === taskId && row.skill_id === skill.id && row.mode === mode && row.content_sha256 === skill.content_sha256 && row.resolved_identity === identity) return row;
    // Legacy selection IDs are optional receipt correlation, never authority.
  }
  if (selections.size >= 256) selections.delete(selections.keys().next().value!);
  const row: Selection = { id: randomUUID(), binding: owner, skill_id: skill.id,
    content_sha256: skill.content_sha256!, mode, phase, created_at: new Date().toISOString(),
    invocation_id: scope?.invocationId ?? null, goal_id: scope?.goalId ?? null, task_id: taskId,
    resources: await resourcesFor(skill), coverage: new Map(), resolved_identity: identity };
  selections.set(row.id, row);
  return row;
}
export async function resourcePage(selection: Selection, offset = 0, limit = 20) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid Skill resource page.");
  const page = await Promise.all(selection.resources.slice(offset, offset + limit).map(async ({ file, root, root_identity, ...entry }) => {
    try {
      const { sha256 } = await readSelectedResource(selection, entry.relative_path);
      return { ...entry, sha256, load_params: { name: selection.skill_id, invocation_mode: selection.mode, resource_path: entry.relative_path, expected_resource_sha256: sha256 } };
    } catch {
      return { ...entry, sha256: null, load_params: { name: selection.skill_id, invocation_mode: selection.mode, resource_path: entry.relative_path }, unavailable: true };
    }
  }));
  return { total: selection.resources.length, offset, entries: page,
    next_offset: offset + page.length < selection.resources.length ? offset + page.length : null };
}
export async function readSelectedResource(selection: Selection, relativePath: string, expectedHash?: string) {
  if (path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").some(part => !part || part === "." || part === "..") || relativePath.includes(":")) {
    throw new Error("SKILL_RESOURCE_PATH_INVALID");
  }
  const resource = selection.resources.find(item => item.relative_path === relativePath);
  if (!resource) throw new Error("SKILL_RESOURCE_NOT_SELECTED: refresh the resource directory.");
  const currentRoot = await fs.realpath(resource.root);
  const rootStat = await fs.stat(currentRoot);
  if (currentRoot !== resource.root || `${rootStat.dev}:${rootStat.ino}` !== resource.root_identity) throw new Error("SKILL_RESOURCE_ROOT_CHANGED: reselect this Skill package.");
  const real = await fs.realpath(resource.file);
  if (!inside(resource.root, real)) throw new Error("SKILL_RESOURCE_OUTSIDE_ROOT");
  const handle = await fs.open(real, "r");
  try {
    const st = await handle.stat();
    const after = await fs.realpath(resource.file);
    const named = await fs.stat(after);
    if (!st.isFile() || after !== real || !inside(resource.root, after) || st.ino !== named.ino || st.dev !== named.dev) throw new Error("SKILL_RESOURCE_CHANGED_DURING_OPEN");
    if (st.size > 8_000_000) throw new Error("SKILL_RESOURCE_TOO_LARGE: read-only guidance resources are limited to 8 MB.");
    const data = await handle.readFile();
    const sha256 = digest(data);
    if (expectedHash && sha256 !== expectedHash) throw new Error(`SKILL_RESOURCE_VERSION_CHANGED: supplied=${expectedHash}; current=${sha256}. Restart this resource read.`);
    return { data, sha256 };
  } finally { await handle.close(); }
}
export async function recordSkillRange(selection: Selection, resource: string, sha256: string, total: number, start: number, end: number) {
  let item = selection.coverage.get(resource);
  if (!item || item.sha256 !== sha256) item = { sha256, total, ranges: [] };
  const ranges = [...item.ranges, [start, end] as Range].sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  item.ranges = merged; selection.coverage.set(resource, item);
  const coverage_complete = merged.length === 1 && merged[0][0] === 0 && merged[0][1] === total;
  const receipt = { kind: "server_content_constructed", selection_id: selection.id, skill_id: selection.skill_id,
    account_session_task_binding: selection.binding, goal_id: selection.goal_id, task_id: selection.task_id, phase: selection.phase,
    selection_invocation_id: selection.invocation_id, invocation_id: getRuntimeScope()?.invocationId ?? null,
    resource_path: resource, sha256, start_bytes: start, end_bytes: end, total_bytes: total,
    supplied_ranges: merged, coverage_complete, persistence: "best_effort_audit",
    meaning: "Server constructed these byte ranges; receipt does not prove host delivery, reading, understanding or application." };
  await audit({ tool: "load_skill", action: "skill_content_constructed", status: "ok", details: receipt });
  return receipt;
}
export async function recordSkillApplication(selection: Selection, statement: string) {
  const receipt = { kind: "model_application_declared", selection_id: selection.id, skill_id: selection.skill_id,
    account_session_task_binding: selection.binding, phase: selection.phase, goal_id: selection.goal_id, task_id: selection.task_id,
    statement, independently_verified: false, persistence: "best_effort_audit" };
  await audit({ tool: "load_skill", action: "skill_application_declared", status: "ok", details: receipt });
  return receipt;
}
export async function recordSkillArtifact(selection: Selection, artifactPath: string, expectedHash: string) {
  // Path must already have passed the ordinary read permission checks.
  const handle = await fs.open(artifactPath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Skill artifact must be an ordinary file.");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("SKILL_ARTIFACT_CHANGED_DURING_HASH");
    const actual = hash.digest("hex");
    const receipt = { kind: "artifact_hash_checked", selection_id: selection.id, skill_id: selection.skill_id,
      account_session_task_binding: selection.binding, phase: selection.phase, goal_id: selection.goal_id, task_id: selection.task_id,
      path: artifactPath, sha256: actual, expected_sha256: expectedHash, hash_matches: actual === expectedHash,
      workflow_quality_verified: false, persistence: "best_effort_audit" };
    await audit({ tool: "load_skill", action: "skill_artifact_hash_checked", status: actual === expectedHash ? "ok" : "error", details: receipt });
    return receipt;
  } finally { await handle.close(); }
}
