import { physicalPromises as fs } from "./physical-fs.js";
import path from "path";
import { assertWritable, decodeText, encodeText } from "./text-codec.js";
import { assertFileRevision, readFileForEdit, writeFileBytesCas, withCanonicalFileLocks } from "./safe-text-write.js";

/**
 * Apply unified diff / Codex-style patches to text.
 * Supports:
 * - Codex/OpenAI format: hunk header "@@" without line numbers, optionally
 *   "@@ <anchor line>", and a first hunk without any "@@"
 * - Standard unified diff: "@@ -1,3 +1,4 @@"
 * - Mixed CRLF/LF input (normalized to LF for matching, preserves original EOL when possible)
 *
 * Every hunk is checked against the file before it is applied. A numbered
 * hunk whose context is not at its line is searched for nearby (like GNU
 * patch offsets); if its lines are nowhere, the patch fails instead of
 * replacing whatever happens to be at that line number.
 */

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

interface HunkLine { type: "context" | "remove" | "add"; text: string }

interface ParsedHunk {
  oldStart?: number;
  oldCount?: number;
  /** Codex "@@ def handler():" — the hunk follows this line. */
  anchor?: string;
  /** Codex "*** End of File" — the hunk ends at the end of the file. */
  endOfFile?: boolean;
  lines: HunkLine[];
}

const GIT_METADATA = /^(?:diff |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/;

function parsePatch(patchText: string): ParsedHunk[] {
  const lines = normalizeEol(patchText).split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const hunks: ParsedHunk[] = [];
  let current: ParsedHunk | null = null;
  const close = (): void => {
    if (current && current.lines.length) hunks.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("@@")) {
      close();
      const numbered = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(.*)$/.exec(line);
      current = numbered
        ? { oldStart: Number(numbered[1]), oldCount: numbered[2] === undefined ? 1 : Number(numbered[2]), lines: [] }
        : { anchor: line.replace(/^@@\s*/, "").replace(/\s*@@\s*$/, "").trim() || undefined, lines: [] };
      continue;
    }
    if (line === "*** End of File") { if (current) current.endOfFile = true; continue; }
    if (line === "\\ No newline at end of file") continue;
    if (!current) {
      // Before the first hunk: "--- a/x" + "+++ b/x" headers and git metadata.
      if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) { i++; continue; }
      if (GIT_METADATA.test(line) || line.startsWith("*** ")) continue;
      // Codex patches may omit the first "@@": its lines start an implicit hunk.
      if (!/^[ +-]/.test(line)) continue;
      current = { lines: [] };
    }
    const hunk = current as ParsedHunk;
    if (line.startsWith(" ")) hunk.lines.push({ type: "context", text: line.slice(1) });
    else if (line.startsWith("-")) hunk.lines.push({ type: "remove", text: line.slice(1) });
    else if (line.startsWith("+")) hunk.lines.push({ type: "add", text: line.slice(1) });
    else if (line.length === 0) hunk.lines.push({ type: "context", text: "" });
  }
  close();

  if (hunks.length === 0) {
    throw new Error("No valid patch hunks found. Use @@ hunks with +/- lines, or the *** Begin Patch format.");
  }
  return hunks;
}

type LineMatch = (fileLine: string, patchLine: string) => boolean;
// Exact first; then tolerate trailing, then surrounding whitespace, the most
// common difference between a model's copy and the file.
const MATCHERS: readonly LineMatch[] = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
];

function matchesAt(lines: string[], pattern: string[], index: number, same: LineMatch): boolean {
  if (index < 0 || index + pattern.length > lines.length) return false;
  for (let j = 0; j < pattern.length; j++) if (!same(lines[index + j], pattern[j])) return false;
  return true;
}

function findForward(lines: string[], pattern: string[], from: number): number {
  for (const same of MATCHERS) {
    for (let i = Math.max(0, from); i <= lines.length - pattern.length; i++) if (matchesAt(lines, pattern, i, same)) return i;
  }
  return -1;
}

/** Closest occurrence to the expected line, searching outwards. */
function findNear(lines: string[], pattern: string[], target: number): number {
  const last = lines.length - pattern.length;
  for (const same of MATCHERS) {
    for (let distance = 0; target - distance >= 0 || target + distance <= last; distance++) {
      if (matchesAt(lines, pattern, target + distance, same)) return target + distance;
      if (distance && matchesAt(lines, pattern, target - distance, same)) return target - distance;
    }
  }
  return -1;
}

function findAnchor(lines: string[], anchor: string, from: number): number {
  const wanted = anchor.trim();
  for (let i = Math.max(0, from); i < lines.length; i++) if (lines[i].trim() === wanted) return i;
  for (let i = Math.max(0, from); i < lines.length; i++) if (lines[i].includes(wanted)) return i;
  return -1;
}

/** Index after the last content line (a final newline yields a trailing ""). */
function contentEnd(lines: string[]): number {
  return lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** Replace in place; context keeps the file's own text. Returns the line-count change. */
function applyAt(lines: string[], hunk: ParsedHunk, index: number): number {
  const replacement: string[] = [];
  let cursor = index;
  for (const entry of hunk.lines) {
    if (entry.type === "context") replacement.push(lines[cursor++]);
    else if (entry.type === "remove") cursor++;
    else replacement.push(entry.text);
  }
  const removed = cursor - index;
  lines.splice(index, removed, ...replacement);
  return replacement.length - removed;
}

function contextNotFound(hunk: ParsedHunk, pattern: string[]): Error {
  const preview = pattern.slice(0, 3).join(" | ") || "(empty hunk)";
  const where = hunk.oldStart !== undefined ? ` near line ${hunk.oldStart}` : hunk.anchor ? ` after "${hunk.anchor}"` : "";
  return new Error(`Patch context not found in file${where}. Expected lines like: ${preview}. Re-read the file and rebuild the hunk from its current text.`);
}

export function applyUnifiedPatchToText(original: string, patchText: string): string {
  const eol = detectEol(original);
  const lines = normalizeEol(original).split("\n");
  const hunks = parsePatch(patchText);

  let offset = 0;
  let searchFrom = 0;
  for (const hunk of hunks) {
    const pattern = hunk.lines.filter((entry) => entry.type !== "add").map((entry) => entry.text);
    let index = -1;
    if (hunk.oldStart !== undefined) {
      // "-5,0" inserts after line 5; "-5,3" starts at line 5.
      const expected = Math.max(0, (hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1) + offset);
      index = findNear(lines, pattern, Math.min(expected, lines.length));
      if (index >= 0) offset += index - expected;
    } else {
      const anchorAt = hunk.anchor ? findAnchor(lines, hunk.anchor, searchFrom) : -1;
      const from = anchorAt >= 0 ? anchorAt + 1 : searchFrom;
      if (hunk.endOfFile) {
        const atEnd = contentEnd(lines) - pattern.length;
        if (MATCHERS.some((same) => matchesAt(lines, pattern, atEnd, same))) index = atEnd;
      }
      if (index < 0 && pattern.length === 0) index = anchorAt >= 0 ? from : contentEnd(lines);
      if (index < 0) index = findForward(lines, pattern, from);
      // Hunks given out of order, or an anchor that is not in the file.
      if (index < 0 && from > 0) index = findForward(lines, pattern, 0);
    }
    if (index < 0) throw contextNotFound(hunk, pattern);
    const delta = applyAt(lines, hunk, index);
    if (hunk.oldStart !== undefined) offset += delta;
    searchFrom = index + pattern.length + delta;
  }

  const result = lines.join("\n");
  return eol === "\r\n" ? result.replace(/\n/g, "\r\n") : result;
}

export interface MultiPatchFileOp {
  path: string;
  operation: "create" | "update" | "delete";
  patch?: string;
  content?: string;
  /** Codex "*** Move to:" or a unified diff whose +++ path differs. */
  moveTo?: string;
}

export interface MultiPatchResult {
  path: string;
  operation: "create" | "update" | "delete";
  ok: boolean;
  diff?: string;
  error?: string;
  moved_to?: string;
  encoding?: string;
}

export function isMultiFilePatch(patchText: string): boolean {
  const t = normalizeEol(patchText.trim());
  // A removed "-- comment" line reads "--- comment"; only a ---/+++ header
  // pair (or git metadata) marks a file section.
  return (
    t.includes("*** Begin Patch") ||
    t.includes("*** Update File:") ||
    t.includes("*** Add File:") ||
    t.includes("*** Delete File:") ||
    /^--- [^\n]*\n\+\+\+ /m.test(t) ||
    /^diff --git /m.test(t)
  );
}

/** Path from a "--- " / "+++ " header; null for /dev/null. */
function headerPath(raw: string): string | null {
  const value = raw.split("\t")[0].trim().replace(/^"(.*)"$/, "$1");
  if (value === "/dev/null" || value === "nul" || value === "NUL") return null;
  return value.replace(/^[ab]\//, "");
}

function addedContent(body: string): string {
  const lines = normalizeEol(body).split("\n");
  const added = lines.filter((line) => line.startsWith("+")).map((line) => line.slice(1));
  if (!added.length) return "";
  return added.join("\n") + (lines.includes("\\ No newline at end of file") ? "" : "\n");
}

export function parseMultiFilePatch(patchText: string, baseDir?: string): MultiPatchFileOp[] {
  const normalized = normalizeEol(patchText.trim());
  const ops: MultiPatchFileOp[] = [];

  if (normalized.includes("*** Begin Patch") || /^\*\*\* (?:Update|Add|Delete) File:/m.test(normalized)) {
    const lines = normalized.split("\n");
    let current: MultiPatchFileOp | null = null;
    const chunk: string[] = [];

    const flush = () => {
      if (!current) return;
      if (current.operation === "create") {
        const added = chunk.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
        current.content = added.length ? added.join("\n") + "\n" : "";
      } else if (current.operation === "update") {
        current.patch = chunk.join("\n");
      }
      ops.push(current);
      current = null;
      chunk.length = 0;
    };

    for (const line of lines) {
      if (line.startsWith("*** Update File:")) {
        flush();
        current = { path: resolvePatchPath(line.slice(16).trim(), baseDir), operation: "update" };
        continue;
      }
      if (line.startsWith("*** Add File:")) {
        flush();
        current = { path: resolvePatchPath(line.slice(13).trim(), baseDir), operation: "create" };
        continue;
      }
      if (line.startsWith("*** Delete File:")) {
        flush();
        ops.push({ path: resolvePatchPath(line.slice(16).trim(), baseDir), operation: "delete" });
        continue;
      }
      if (line.startsWith("*** Move to:")) {
        const target: MultiPatchFileOp | null = current;
        if (target && target.operation === "update") target.moveTo = resolvePatchPath(line.slice(12).trim(), baseDir);
        continue;
      }
      if (line.startsWith("*** End Patch") || line.startsWith("*** Begin Patch")) continue;
      if (current) chunk.push(line);
    }
    flush();
    return ops;
  }

  // Unified diff multi-file: one section per "--- old" / "+++ new" header pair.
  const blocks = normalized.split(/\n(?=--- [^\n]*\n\+\+\+ )/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines.findIndex((line, index) => line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ "));
    if (header < 0) continue;
    const oldPath = headerPath(lines[header].slice(4));
    const newPath = headerPath(lines[header + 1].slice(4));
    const body = lines.slice(header + 2).join("\n");
    if (newPath === null && oldPath !== null) {
      ops.push({ path: resolvePatchPath(oldPath, baseDir), operation: "delete" });
    } else if (oldPath === null && newPath !== null) {
      ops.push({ path: resolvePatchPath(newPath, baseDir), operation: "create", content: addedContent(body) });
    } else if (oldPath !== null && newPath !== null) {
      const source = resolvePatchPath(oldPath, baseDir), target = resolvePatchPath(newPath, baseDir);
      ops.push({ path: source, operation: "update", patch: body, ...(source === target ? {} : { moveTo: target }) });
    }
  }

  return ops;
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

function resolvePatchPath(input: string, baseDir?: string): string {
  const cleaned = input.trim().replace(/^['"]|['"]$/g, "");
  if (path.isAbsolute(cleaned)) return path.resolve(cleaned);
  if (baseDir) return path.resolve(baseDir, cleaned);
  return path.resolve(cleaned);
}

function hasHunkLines(patchText: string | undefined): boolean {
  return Boolean(patchText && normalizeEol(patchText).split("\n").some((line) => line.startsWith("@@") || /^[+-]/.test(line)));
}

export async function applyMultiFilePatch(
  patchText: string,
  options?: { base_dir?: string; dry_run?: boolean; before_commit?: (target: string) => Promise<void> }
): Promise<MultiPatchResult[]> {
  const baseDir = options?.base_dir;
  const dryRun = options?.dry_run ?? false;
  const ops = parseMultiFilePatch(patchText, baseDir);
  if (ops.length === 0) throw new Error("No file operations found in patch");

  const results: MultiPatchResult[] = [];

  for (const op of ops) {
    try {
      if (op.operation === "delete") {
        if (!dryRun) { await options?.before_commit?.(op.path); await fs.unlink(op.path); }
        results.push({ path: op.path, operation: "delete", ok: true, diff: "[deleted]" });
        continue;
      }

      if (op.operation === "create") {
        const content = op.content ?? "";
        if (!dryRun) {
          await writeFileBytesCas(op.path, Buffer.from(content, "utf8"), { createOnly: true,
            beforeCommit: () => options?.before_commit?.(op.path) ?? Promise.resolve() });
        }
        results.push({ path: op.path, operation: "create", ok: true, diff: buildSimpleDiff("", content) });
        continue;
      }

      const snapshot = await readFileForEdit(op.path);
      const bytes = snapshot.bytes;
      const decoded = decodeText(bytes);
      // A Codex "*** Move to:" without hunks is a pure rename.
      const next = op.moveTo && !hasHunkLines(op.patch) ? decoded.text : applyUnifiedPatchToText(decoded.text, op.patch || "");
      const diff = buildSimpleDiff(decoded.text, next);
      if (!dryRun) {
        const target = op.moveTo ?? op.path;
        const output = next === decoded.text ? bytes : (assertWritable(decoded, op.path), encodeText(next, decoded.encoding));
        let destination: Awaited<ReturnType<typeof readFileForEdit>> | null = null;
        if (op.moveTo && !samePath(target, op.path)) {
          try { await fs.lstat(target); destination = await readFileForEdit(target); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        const sameTarget = !op.moveTo || samePath(target, op.path) ||
          (destination && samePath(destination.revision.canonicalPath, snapshot.revision.canonicalPath));
        if (sameTarget) {
          // Do not acquire the same canonical lock twice for case-only moves or aliases.
          await writeFileBytesCas(op.path, output, { expectedRevision: snapshot.revision,
            beforeCommit: () => options?.before_commit?.(op.path) ?? Promise.resolve() });
          if (op.moveTo && samePath(target, op.path) && target !== op.path) await fs.rename(op.path, target);
        } else {
          // Keep the source revision locked while publishing its edited bytes
          // at the destination. A failed publication never removes the source.
          await withCanonicalFileLocks([op.path, target], async scope => {
            await assertFileRevision(op.path, snapshot.revision);
            await scope.writeBytes(target, output, { expectedRevision: destination?.revision,
              createOnly: !destination, mode: snapshot.revision.mode,
              beforeCommit: async () => {
                await options?.before_commit?.(target);
                await assertFileRevision(op.path, snapshot.revision);
              } });
            await options?.before_commit?.(op.path);
            await assertFileRevision(op.path, snapshot.revision);
            // Remove the source entry, preserving the existing semantics when
            // it is a file symlink rather than deleting its resolved referent.
            await fs.unlink(op.path);
          });
        }
      }
      results.push({ path: op.path, operation: "update", ok: true, diff,
        ...(op.moveTo ? { moved_to: op.moveTo } : {}),
        ...(decoded.encoding !== "utf-8" ? { encoding: decoded.encoding } : {}) });
    } catch (err) {
      results.push({
        path: op.path,
        operation: op.operation,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export function buildSimpleDiff(oldContent: string, newContent: string): string {
  const oldLines = normalizeEol(oldContent).split("\n");
  const newLines = normalizeEol(newContent).split("\n");
  const diff: string[] = [];
  let oldAt = 0;
  let newAt = 0;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;

  while (oldAt < oldEnd && newAt < newEnd && oldLines[oldAt] === newLines[newAt]) {
    oldAt++;
    newAt++;
  }
  // A line inserted near the beginning must not make the unchanged suffix
  // appear deleted and re-added. Keep all actual edits, not a sliced preview.
  while (oldEnd > oldAt && newEnd > newAt && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  // A fixed lookahead resynchronizes separated insertions/deletions without
  // quadratic LCS memory. This is an edit summary, not a minimal unified patch.
  // Large true edits are still returned in full to the existing result guard.
  const lookahead = 64;
  while (oldAt < oldEnd && newAt < newEnd) {
    if (oldLines[oldAt] === newLines[newAt]) {
      oldAt++;
      newAt++;
      continue;
    }
    let deletion = 0;
    let insertion = 0;
    for (let distance = 1; distance <= lookahead; distance++) {
      if (!deletion && oldAt + distance < oldEnd && oldLines[oldAt + distance] === newLines[newAt]) deletion = distance;
      if (!insertion && newAt + distance < newEnd && newLines[newAt + distance] === oldLines[oldAt]) insertion = distance;
      if (deletion || insertion) break;
    }
    if (insertion && (!deletion || insertion <= deletion)) {
      for (let count = 0; count < insertion; count++) diff.push(`+ ${newLines[newAt++]}`);
    } else if (deletion) {
      for (let count = 0; count < deletion; count++) diff.push(`- ${oldLines[oldAt++]}`);
    } else {
      diff.push(`- ${oldLines[oldAt++]}`);
      diff.push(`+ ${newLines[newAt++]}`);
    }
  }
  while (oldAt < oldEnd) diff.push(`- ${oldLines[oldAt++]}`);
  while (newAt < newEnd) diff.push(`+ ${newLines[newAt++]}`);

  return diff.join("\n") || "(no visible diff)";
}
