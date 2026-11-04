import fs from "fs/promises";
import path from "path";

export type GrepOutputMode = "content" | "files_with_matches" | "count";
export interface GrepOptions {
  pattern: string; path: string; glob?: string; outputMode?: GrepOutputMode;
  caseInsensitive?: boolean; multiline?: boolean; headLimit?: number;
  contextBefore?: number; contextAfter?: number; contextAround?: number;
  offset?: number;
}
export interface GrepSearchPage {
  output: string;
  offset: number;
  rows: number;
  next_offset: number | null;
  complete: boolean;
  truncated: boolean;
  reasons: string[];
  visited_files: number;
  total_matches_observed: number;
}
export const GREP_MAX_OUTPUT_CHARS = 64_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 5000;
export const MAX_SEARCH_MS = 10_000;
const binaryExtension = /\.(?:exe|dll|zip|7z|tar|gz|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|mp4|mp3|asar|blockmap)$/i;

function globToRegExp(pattern: string): RegExp {
  let expression = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") { expression += "(?:.*/)?"; i += 2; }
    else if (ch === "*") expression += ".*";
    else if (ch === "?") expression += ".";
    else expression += /[.\+^${}()|\[\]\\]/.test(ch) ? "\\" + ch : ch;
  }
  return new RegExp("^" + expression + "$", "i");
}

// Every omission is explicit. The search is not claimed complete when a time,
// file, line or byte cap applies. Narrow the path/glob to continue inspection.
export async function grepSearchPage(options: GrepOptions): Promise<GrepSearchPage> {
  const { pattern, path: searchRoot, glob = "*", outputMode = "content",
    caseInsensitive = false, multiline = false, headLimit = 200,
    contextBefore = 0, contextAfter = 0, contextAround = 0, offset = 0 } = options;
  const regex = new RegExp(pattern, (caseInsensitive ? "i" : "") + (multiline ? "m" : ""));
  const matcher = globToRegExp(glob);
  const limit = Math.max(1, Math.min(1000, headLimit));
  const startOffset = Math.max(0, Math.floor(offset));
  const before = Math.min(20, Math.max(0, contextAround || contextBefore));
  const after = Math.min(20, Math.max(0, contextAround || contextAfter));
  const root = path.resolve(searchRoot);
  const started = performance.now();
  const output: string[] = [];
  const reasons = new Set<string>();
  let outputChars = 0, visited = 0, totalMatches = 0, rowsObserved = 0;
  function capped(): boolean {
    if (performance.now() - started >= MAX_SEARCH_MS) { reasons.add("time budget"); return true; }
    if (visited >= MAX_FILES) { reasons.add("file budget"); return true; }
    if (output.length >= limit) { reasons.add("head_limit"); return true; }
    if (outputChars >= GREP_MAX_OUTPUT_CHARS) { reasons.add("output character budget"); return true; }
    return false;
  }
  function emit(line: string): boolean {
    if (rowsObserved++ < startOffset) return true;
    if (output.length >= limit) { reasons.add("head_limit"); return false; }
    const remaining = GREP_MAX_OUTPUT_CHARS - outputChars - 1;
    if (line.length > remaining) {
      if (remaining > 0) output.push(line.slice(0, remaining));
      outputChars = GREP_MAX_OUTPUT_CHARS;
      reasons.add("output character budget"); return false;
    }
    output.push(line); outputChars += line.length + 1; return true;
  }
  async function inspect(file: string): Promise<void> {
    if (capped()) return;
    visited++;
    if (binaryExtension.test(file)) { reasons.add("binary files omitted"); return; }
    let text: string;
    try {
      const handle = await fs.open(file, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return;
        if (stat.size > MAX_FILE_BYTES) { reasons.add("files larger than 2 MiB omitted"); return; }
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (buffer.subarray(0, Math.min(bytesRead, 8192)).includes(0)) { reasons.add("binary files omitted"); return; }
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally { await handle.close(); }
    } catch { reasons.add("unreadable files omitted"); return; }
    if (multiline) {
      const all = new RegExp(pattern, regex.flags + "g");
      let count = 0;
      for (const _ of text.matchAll(all)) { count++; if (count >= 100000) { reasons.add("match budget"); break; } }
      if (count) { totalMatches += count; emit(outputMode === "files_with_matches" ? file : outputMode === "count" ? `${file}:${count}` : `${file}: [multiline match x${count}]`); }
      return;
    }
    const lines = text.split(/\r?\n/);
    let count = 0;
    const seen = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (performance.now() - started >= MAX_SEARCH_MS) { reasons.add("time budget"); break; }
      if (!regex.test(lines[i])) continue;
      count++; totalMatches++;
      if (outputMode !== "content") continue;
      for (let n = Math.max(0, i - before); n <= Math.min(lines.length - 1, i + after); n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (!emit(`${file}${n === i ? ":" : "-"}${n + 1}: ${lines[n]}`)) break;
      }
      if (capped()) break;
    }
    if (count && outputMode !== "content") emit(outputMode === "count" ? `${file}:${count}` : file);
  }
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { reasons.add("unreadable directories omitted"); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (capped()) break;
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && (matcher.test(entry.name) || matcher.test(path.relative(root, full).replace(/\\/g, "/")))) await inspect(full);
    }
  }
  const stat = await fs.stat(root);
  if (stat.isFile()) await inspect(root);
  else if (stat.isDirectory()) await walk(root);
  else throw new Error("Search target is not a regular file or directory");
  const body = output.join("\n") || (totalMatches ? "Matches found; output limited" : "No matches found");
  const reasonList = [...reasons];
  const truncated = reasonList.length > 0;
  const nextOffset = reasons.has("head_limit") && output.length > 0 ? startOffset + output.length : null;
  return {
    output: truncated ? body + `\n[search incomplete: ${reasonList.join("; ")}. Continue with next_offset when present, or narrow the path/glob.]` : body,
    offset: startOffset,
    rows: output.length,
    next_offset: nextOffset,
    complete: !truncated,
    truncated,
    reasons: reasonList,
    visited_files: visited,
    total_matches_observed: totalMatches,
  };
}

export async function grepSearch(options: GrepOptions): Promise<string> {
  return (await grepSearchPage(options)).output;
}
