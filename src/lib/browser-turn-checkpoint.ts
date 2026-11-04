import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BrowserTurnFenceState } from "./browser-turn-fence.js";
import { writeTextFileCas } from "./safe-text-write.js";

export interface BrowserTurnCheckpoint {
  version: 1;
  session_id: string;
  target_id: string;
  phase: string;
  fence: BrowserTurnFenceState;
  updated_at: string;
  terminal: boolean;
}

function checkpointRoot(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(home, "browser-turn-checkpoints");
}

function checkpointPath(sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex");
  return path.join(checkpointRoot(), `${key}.json`);
}

export async function saveBrowserTurnCheckpoint(value: BrowserTurnCheckpoint): Promise<string> {
  const file = checkpointPath(value.session_id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeTextFileCas(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

export async function loadBrowserTurnCheckpoint(sessionId: string): Promise<BrowserTurnCheckpoint | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(checkpointPath(sessionId), "utf8")) as BrowserTurnCheckpoint;
    if (parsed.version !== 1 || parsed.session_id !== sessionId || !parsed.fence) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function browserCheckpointPath(sessionId: string): string {
  return checkpointPath(sessionId);
}