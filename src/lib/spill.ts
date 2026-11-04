import fs from "node:fs/promises";
import path from "node:path";

/**
 * Spill reference semantics (ported from DeepSeek Harness spill-policy): an
 * oversized tool output lives in a durable file; the tool result carries an
 * opaque locator plus a retrieval hint naming the tools that can read it.
 * Best-effort by design — a spill metadata failure keeps the original result.
 */

export interface SpillRef {
  locator: string;
  bytes: number;
  retrieval_hint: string;
}

export const SPILL_RETRIEVAL_HINT =
  "Use read_text_file with offset/limit on this path to inspect the full content, or grep it for specific lines.";

export async function toSpillRef(filePath: string | undefined | null): Promise<SpillRef | undefined> {
  if (!filePath) return undefined;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return undefined;
    return {
      locator: path.resolve(filePath),
      bytes: stat.size,
      retrieval_hint: SPILL_RETRIEVAL_HINT,
    };
  } catch {
    return undefined;
  }
}
