import { createHash } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";

const MAX_BYTES = parseInt(process.env.AUTO_MEMORY_MAX_BYTES || "25000", 10);
const MAX_LINES = parseInt(process.env.AUTO_MEMORY_MAX_LINES || "200", 10);

function projectDir(workspaceRoot: string): string {
  const slug = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", slug);
}

function memoryPath(workspaceRoot: string): string {
  return path.join(projectDir(workspaceRoot), "MEMORY.md");
}

export async function loadAutoMemory(
  workspaceRoot: string,
  opts?: { maxBytes?: number; maxLines?: number }
): Promise<string | null> {
  try {
    const buf = await fs.readFile(memoryPath(workspaceRoot));
    const text = buf.toString("utf-8");
    const maxBytes = opts?.maxBytes ?? MAX_BYTES;
    const maxLines = opts?.maxLines ?? MAX_LINES;
    const lines = text.split(/\r?\n/).slice(0, maxLines).join("\n");
    const limited =
      Buffer.byteLength(lines, "utf-8") > maxBytes
        ? Buffer.from(lines, "utf-8").subarray(0, maxBytes).toString("utf-8")
        : lines;
    return limited.trim() || null;
  } catch {
    return null;
  }
}

export async function appendAutoMemory(workspaceRoot: string, note: string): Promise<string> {
  const dir = projectDir(workspaceRoot);
  const file = memoryPath(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });

  const line = `- ${new Date().toISOString().slice(0, 10)}: ${note.trim()}\n`;
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf-8");
  } catch {}

  const header = existing ? "" : "# Auto memory (cross-session notes)\n\n";
  await fs.writeFile(file, header + existing + line, "utf-8");
  return file;
}

export function formatAutoMemoryForInstructions(content: string | null): string {
  if (!content) return "";
  return ["## Auto memory (learned across sessions)", content].join("\n");
}