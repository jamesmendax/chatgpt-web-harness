import physicalFs, { physicalPromises as fs } from "../lib/physical-fs.js";
const { createReadStream } = physicalFs;
import path from "path";
import { createHash, randomUUID } from "crypto";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDefaultCwd, validatePath } from "../lib/path-security.js";
import { assertWritable, decodeText, encodeText, type DecodedText } from "../lib/text-codec.js";
import { createLineMatcher, replaceWithDeadline } from "../lib/regex-budget.js";
import { audit } from "../lib/audit.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { applyMultiFilePatch, applyUnifiedPatchToText, buildSimpleDiff, isMultiFilePatch, parseMultiFilePatch } from "../lib/patch.js";
import { checkpointBefore, checkpointBeforeDetailed } from "../lib/checkpoint.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { enrichAfterEdit } from "../lib/edit-enrichment.js";
import { toolResult } from "../lib/tool-result.js";
import { globFiles } from "../lib/glob-search.js";
import { grepSearchPage } from "../lib/grep-search.js";
import { loadPathRulesForFile } from "../lib/path-rules.js";
import { readFileForEdit, writeFileBytesCas, writeTextFileCas, withCanonicalFileLock } from "../lib/safe-text-write.js";
import { fetchFileResponse, resolveFileProxy } from "../lib/file-download-network.js";
import { writeAll, writeStagedBinary } from "../lib/binary-upload.js";

// Edited text goes back in the file's own encoding (GBK stays GBK, UTF-16
// keeps its BOM). Encode before any checkpoint or write, so a refused edit
// (unknown bytes, a character GBK cannot hold) changes nothing.
function editedBytes(decoded: DecodedText, next: string, filePath: string): Buffer {
  assertWritable(decoded, filePath);
  return encodeText(next, decoded.encoding);
}

function encodingNote(decoded: DecodedText): Record<string, string | boolean> {
  return decoded.encoding === "utf-8" && !decoded.lossy ? {} : { encoding: decoded.encoding, ...(decoded.lossy ? { encoding_lossy: true } : {}) };
}

async function publishEditWithCheckpoint(tool: string, requestedPath: string, validPath: string,
  snapshot: Awaited<ReturnType<typeof readFileForEdit>>, output: Buffer | null, dryRun: boolean) {
  if (!output) return checkpointBeforeDetailed(tool, [validPath], { dry_run: dryRun });
  let checkpoint: Awaited<ReturnType<typeof checkpointBeforeDetailed>> | undefined;
  await writeFileBytesCas(validPath, output, {
    expectedRevision: snapshot.revision,
    beforePublish: async () => { checkpoint = await checkpointBeforeDetailed(tool, [validPath]); },
    beforeCommit: async () => {
      requireWriteAllowed();
      const fresh = await validatePath(requestedPath);
      const comparable = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
      if (comparable(fresh) !== comparable(validPath)) throw new Error("WRITE_CONFLICT: edit target path changed before publication");
    },
  });
  return checkpoint!;
}

const MAX_BINARY_CHUNK_BYTES = 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_BINARY_CHUNK_BYTES / 3) * 4;
export const MAX_CHATGPT_FILE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CHATGPT_FILE_TIMEOUT_MS = 120_000;
export const MAX_CHATGPT_FILE_TIMEOUT_MS = 900_000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const MAX_TEXT_FILE_BYTES = Math.max(
  64 * 1024,
  Number.parseInt(process.env.READ_TEXT_MAX_FILE_BYTES || "33554432", 10) || 32 * 1024 * 1024
);
const MAX_TEXT_RESULT_CHARS = Math.max(
  10_000,
  Number.parseInt(process.env.READ_TEXT_MAX_CHARS || "50000", 10) || 50_000
);
const MAX_TEXT_RESULT_LINES = Math.max(
  100,
  Number.parseInt(process.env.READ_TEXT_MAX_LINES || "1000", 10) || 1_000
);
const MAX_DIRECTORY_ENTRIES = Math.max(
  100,
  Number.parseInt(process.env.LIST_DIRECTORY_MAX_ENTRIES || "500", 10) || 500
);

function boundedLines(
  lines: string[],
  start: number,
  end: number,
  numbered: boolean,
  characterOffset = 0
): {
  content: string;
  lines_read: number;
  truncated: boolean;
  next_offset: number | null;
  next_character_offset: number | null;
  single_line_truncated: boolean;
} {
  const output: string[] = [];
  const boundedEnd = Math.min(end, lines.length, start + MAX_TEXT_RESULT_LINES);
  let index = start;
  let chars = 0;
  let singleLineTruncated = false;
  let nextCharacterOffset = 0;

  for (; index < boundedEnd; index++) {
    const lineOffset = index === start ? characterOffset : 0;
    const prefix = numbered ? `${String(index + 1).padStart(6, " ")}|` : "";
    const line = lines[index].slice(lineOffset);
    const rendered = prefix + line;
    const extra = rendered.length + (output.length ? 1 : 0);
    if (chars + extra > MAX_TEXT_RESULT_CHARS) {
      if (output.length === 0) {
        let taken = MAX_TEXT_RESULT_CHARS - prefix.length;
        // Do not split a UTF-16 surrogate pair at the continuation boundary.
        const last = line.charCodeAt(taken - 1);
        if (last >= 0xd800 && last <= 0xdbff) taken--;
        output.push(prefix + line.slice(0, taken));
        singleLineTruncated = true;
        nextCharacterOffset = lineOffset + taken;
      }
      break;
    }
    output.push(rendered);
    chars += extra;
  }

  const truncated = singleLineTruncated || index < Math.min(end, lines.length);
  return {
    content: output.join("\n"),
    lines_read: output.length,
    truncated,
    next_offset: truncated ? index + 1 : null,
    next_character_offset: truncated ? nextCharacterOffset : null,
    single_line_truncated: singleLineTruncated,
  };
}

function boundedTail(lines: string[], requested: number): {
  content: string;
  lines_read: number;
  truncated: boolean;
  start_offset: number;
} {
  const lineCount = Math.min(requested, MAX_TEXT_RESULT_LINES, lines.length);
  const start = Math.max(0, lines.length - lineCount);
  const raw = lines.slice(start).join("\n");
  const content = raw.length > MAX_TEXT_RESULT_CHARS ? raw.slice(-MAX_TEXT_RESULT_CHARS) : raw;
  return {
    content,
    lines_read: lineCount,
    truncated: requested > lineCount || raw.length > MAX_TEXT_RESULT_CHARS,
    start_offset: start + 1,
  };
}

const chatGptFileSchema = z.object({
  file_id: z.string().min(1),
  download_url: z.string().url(),
  file_name: z.string().min(1).max(1024).optional(),
  name: z.string().min(1).max(1024).optional(),
  mime_type: z.string().max(255).optional(),
  size: z.number().int().nonnegative().optional(),
}).passthrough();

type ChatGptFileRef = z.infer<typeof chatGptFileSchema>;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function detectFileType(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 6 && (head.subarray(0, 6).toString("ascii") === "GIF87a" || head.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "gif";
  }
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString("ascii") === "RIFF" &&
    head.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  if (head.length >= 5 && head.subarray(0, 5).toString("ascii") === "%PDF-") return "pdf";
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    ((head[2] === 0x03 && head[3] === 0x04) || (head[2] === 0x05 && head[3] === 0x06) || (head[2] === 0x07 && head[3] === 0x08))
  ) {
    return "zip";
  }
  return null;
}

async function readHead(filePath: string, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function decodeBase64Strict(content: string): Buffer {
  const normalized = content.replace(/\s+/g, "");
  if (normalized.length === 0) return Buffer.alloc(0);

  const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (normalized.length % 4 !== 0 || !validBase64.test(normalized)) {
    throw new Error("Invalid base64 content: malformed characters or padding");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.toString("base64") !== normalized) {
    throw new Error("Invalid base64 content: round-trip validation failed");
  }
  return buffer;
}

function isPrivateOrReservedIp(input: string): boolean {
  let ip = input.toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);

  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (version === 6) {
    return (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      /^fe[89ab]/.test(ip)
    );
  }

  return false;
}

export function isProxySyntheticIp(input: string): boolean {
  let ip = input.toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 198 && (b === 18 || b === 19);
}

/** Race uncancellable system DNS against the caller deadline. Late DNS results
 * are observed but cannot authorize a request after cancellation. */
export async function lookupFileAddresses(hostname: string, signal: AbortSignal,
  resolver: (hostname: string) => Promise<{ address: string; family: number }[]> =
    (name) => lookup(name, { all: true, verbatim: true })) {
  signal.throwIfAborted();
  return new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: { address: string; family: number }[]) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve(value!);
    };
    const abort = () => finish(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve().then(() => { signal.throwIfAborted(); return resolver(hostname); })
      .then(value => signal.aborted ? abort() : finish(undefined, value), error => finish(error));
  });
}

export async function assertPublicHttpsUrl(rawUrl: string, signal: AbortSignal, allowProxySynthetic = false,
  resolver?: (hostname: string) => Promise<{ address: string; family: number }[]>): Promise<URL> {
  signal.throwIfAborted();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("ChatGPT file download_url is not a valid URL");
  }

  if (url.username || url.password) throw new Error("ChatGPT file download_url must not contain credentials");
  if (url.protocol !== "https:") {
    throw new Error("ChatGPT file download_url must use HTTPS");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("ChatGPT file download_url points to a local hostname");
  }

  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) throw new Error("ChatGPT file download_url points to a private/reserved IP");
    return url;
  }

  const addresses = await lookupFileAddresses(hostname, signal, resolver);
  if (addresses.length === 0) throw new Error("ChatGPT file download_url hostname did not resolve");
  if (addresses.some(({ address }) => isPrivateOrReservedIp(address) && !(allowProxySynthetic && isProxySyntheticIp(address)))) {
    throw new Error("ChatGPT file download_url resolves to a private/reserved IP");
  }
  return url;
}

async function fetchChatGptFile(downloadUrl: string, signal: AbortSignal,
  fetchResponse: typeof fetchFileResponse = fetchFileResponse): Promise<{ response: Response; finalUrl: string }> {
  let current = downloadUrl;

  for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects++) {
    signal.throwIfAborted();
    const route = await resolveFileProxy(new URL(current), { signal });
    // Fake-IP DNS (Clash/Surge/sing-box TUN mode, 198.18.0.0/15) answers every
    // name with a benchmark-range address even without a system proxy; no real
    // private service lives there, and refusing it failed every download.
    const safeUrl = await assertPublicHttpsUrl(current, signal, true);
    signal.throwIfAborted();
    const response = await fetchResponse(safeUrl, signal, route);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`ChatGPT file download redirect ${response.status} has no Location header`);
      current = new URL(location, safeUrl).toString();
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`ChatGPT file download failed: HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("ChatGPT file download returned an empty response body");
    return { response, finalUrl: safeUrl.toString() };
  }

  throw new Error(`ChatGPT file download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects`);
}

export async function streamResponseBodyToFile(
  response: Response,
  outputPath: string,
  maxBytes = MAX_CHATGPT_FILE_BYTES,
  options: { signal?: AbortSignal; exclusive?: boolean; onProgress?: (bytes: number) => void } = {}
): Promise<{ bytes: number; sha256: string }> {
  if (!response.body) throw new Error("Response has no body");
  options.signal?.throwIfAborted();
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let handle;
  try { handle = await fs.open(outputPath, options.exclusive ? "wx" : "w", 0o600); }
  catch (error) { await reader.cancel().catch(() => undefined); reader.releaseLock(); throw error; }
  let bytes = 0;
  const cancel = () => { void reader.cancel(options.signal?.reason).catch(() => undefined); };
  options.signal?.addEventListener("abort", cancel, { once: true });

  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      const buffer = Buffer.from(value);
      if (bytes + buffer.length > maxBytes) throw new Error(`ChatGPT file exceeds the ${maxBytes} byte safety limit`);
      // FileHandle.write may short-write. writeFile completes this chunk before
      // accounting or hashing it, while retaining bounded streaming memory.
      await handle.writeFile(buffer);
      hash.update(buffer);
      bytes += buffer.length;
      options.onProgress?.(bytes);
    }
    await handle.sync();
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await handle.close();
  }

  return { bytes, sha256: hash.digest("hex") };
}

/** Keep the useful cause code without logging a signed download URL. */
export function describeChatGptTransferError(error: unknown): { message: string; code: string } {
  const codes: string[] = [];
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let i = 0; current && typeof current === "object" && i < 5 && !seen.has(current); i++) {
    seen.add(current);
    const item = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (typeof item.code === "string" && /^[A-Z0-9_]{1,80}$/.test(item.code)) codes.push(item.code);
    if (typeof item.name === "string" && /^(?:Abort|Timeout)Error$/.test(item.name)) codes.push(item.name);
    if (typeof item.message === "string") messages.push(item.message.replace(/https?:\/\/[^\s<>"']+/gi, "[download URL redacted]").slice(0,350));
    current = item.cause;
  }
  return { code: codes.at(-1) || "DOWNLOAD_FAILED", message: [...new Set(messages)].join("; ") || "File transfer failed" };
}

export function fallbackFileName(file: ChatGptFileRef): string {
  const candidate = file.file_name ?? file.name;
  if (!candidate) throw new Error("No destination path was provided and ChatGPT did not provide a file name");
  // On Windows a ":" in the name wrote into an NTFS alternate data stream of
  // another file, and * ? " < > | made the write fail; replace them, and keep
  // names off reserved devices (CON, NUL, COM1 …) and trailing dots/spaces.
  let base = path.basename(candidate.trim()).replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(base)) base = "_" + base;
  if (!base || base === "." || base === ".." || /^_+$/.test(base)) throw new Error("ChatGPT provided an invalid file name");
  return base;
}



// Per file, not per search: a slow tree is fine, a pattern that cannot finish
// one file in this time is catastrophic backtracking.
const SEARCH_FILE_REGEX_BUDGET_MS = 10_000;

async function searchDirectory(
  dir: string,
  match: (lines: string[], timeoutMs: number) => number[],
  globPattern: string,
  results: string[],
  maxResults: number,
  offset: number,
  state: { seen: number; hasMore: boolean; skipped: number },
  isRoot = false
): Promise<void> {
  if (state.hasMore) return;

  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) {
    // One unreadable subfolder (EPERM, EBUSY) used to abort the whole search.
    if (isRoot) throw error;
    state.skipped++;
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (state.hasMore) break;

    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      await searchDirectory(fullPath, match, globPattern, results, maxResults, offset, state);
    } else if (matchesGlob(entry.name, globPattern)) {
      let lines: string[];
      try { lines = (await fs.readFile(fullPath, "utf-8")).split("\n"); }
      catch { state.skipped++; continue; }
      // The pattern is the model's; never let it run without a deadline.
      for (const idx of match(lines, SEARCH_FILE_REGEX_BUDGET_MS)) {
        const row = state.seen++;
        if (row < offset) continue;
        if (results.length < maxResults) {
          results.push(`${fullPath}:${idx + 1}: ${lines[idx].trim()}`);
        } else {
          state.hasMore = true;
          break;
        }
      }
    }
  }
}

export async function searchDirectoryPage(
  dir: string,
  pattern: string,
  globPattern = "*",
  offset = 0,
  maxResults = 50
): Promise<{ matches: string[]; offset: number; next_offset: number | null; complete: boolean; truncated: boolean; unreadable_skipped?: number }> {
  const matches: string[] = [];
  const normalizedOffset = Math.max(0, Math.floor(offset));
  const limit = Math.max(1, Math.min(500, Math.floor(maxResults)));
  const state = { seen: 0, hasMore: false, skipped: 0 };
  await searchDirectory(dir, createLineMatcher(new RegExp(pattern, "i")), globPattern, matches, limit, normalizedOffset, state, true);
  return {
    matches,
    offset: normalizedOffset,
    next_offset: state.hasMore ? normalizedOffset + matches.length : null,
    complete: !state.hasMore,
    truncated: state.hasMore,
    ...(state.skipped ? { unreadable_skipped: state.skipped } : {}),
  };
}

function matchesGlob(filename: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const regex = new RegExp(
    "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(filename);
}

async function buildTree(dirPath: string, depth: number, maxDepth: number): Promise<object> {
  const name = path.basename(dirPath);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  if (depth >= maxDepth) return { name, type: "directory", truncated: true };

  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) children.push(await buildTree(childPath, depth + 1, maxDepth));
    else children.push({ name: entry.name, type: "file" });
  }

  return { name, type: "directory", children };
}

async function deletePhysicalPath(tool: string, input: string, directory: boolean) {
  requireWriteAllowed();
  let target: string;
  try {
    target = await validatePath(input);
    const stat = await fs.lstat(target);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(directory ? "Path is not a directory" : "Path is not a file");
  } catch (error) {
    return toolResult(tool, { path: input, phase: "target_check", failure_phase: "validation", failure_step: "target_check", operation_started: false, may_have_partially_completed: false, error: String(error), error_code: (error as NodeJS.ErrnoException).code }, { ok: false });
  }
  const checkpoint = await checkpointBeforeDetailed(tool, [target]);
  try {
    if (directory) await fs.rm(target, { recursive: true }); else await fs.unlink(target);
  } catch (error) {
    let remaining: string;
    try { await fs.lstat(target); remaining = "present"; } catch (probe) { remaining = (probe as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
    return toolResult(tool, { path: target, phase: "delete", failure_phase: "execution", failure_step: "delete", operation_started: true, may_be_partial: directory, may_have_partially_completed: directory,
      remaining, error: String(error), error_code: (error as NodeJS.ErrnoException).code, checkpoint }, { ok: false });
  }
  try {
    await audit({ tool, action: directory ? "rmdir" : "delete", target, status: "ok" });
    return toolResult(tool, { path: target, phase: "complete", deleted: true, operation_started: true, checkpoint_id: checkpoint.id, checkpoint });
  } catch (error) {
    return toolResult(tool, { path: target, phase: "post_delete", failure_phase: "postprocessing", failure_step: "post_delete", deleted: true, operation_started: true, may_have_partially_completed: true,
      error: String(error), checkpoint_id: checkpoint.id, checkpoint }, { ok: false });
  }
}

export function registerFilesystemTools(server: McpServer, workspaceRoot: string,
  dependencies: { fetchResponse?: typeof fetchFileResponse } = {}): void {
  server.registerTool(
    "read_text_file",
    {
      title: "Read Text File",
      description: "Read a file before editing. offset+limit use 1-based lines. Continue bounded results with next_offset and next_character_offset (as character_offset) so long lines are not lost. The first chunk also returns applicable nested instructions. Very large files need grep or targeted extraction.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().positive().optional().describe("1-based line number to start reading"),
        character_offset: z.number().int().nonnegative().optional().describe("0-based character offset within the starting line; use with offset to resume a long line"),
        limit: z.number().int().positive().optional().describe("Number of lines to read from offset"),
        head: z.number().optional(),
        tail: z.number().optional(),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, offset, character_offset, limit, head, tail }) => {
      if (character_offset !== undefined && (offset === undefined || head !== undefined || tail !== undefined)) {
        throw new Error("character_offset requires offset and cannot be combined with head or tail.");
      }
      const validPath = await validatePath(filePath);
      const stat = await fs.stat(validPath);
      if (!stat.isFile()) throw new Error("Path is not a regular file");
      if (stat.size > MAX_TEXT_FILE_BYTES) {
        throw new Error(
          `Text file is ${stat.size} bytes, above READ_TEXT_MAX_FILE_BYTES=${MAX_TEXT_FILE_BYTES}. Use grep, read_file_base64 chunks, or run_command with targeted extraction instead of loading the whole file.`
        );
      }
      const decoded = decodeText(await fs.readFile(validPath));
      const content = decoded.text;
      // Edits keep this encoding; tell the model when it is not plain UTF-8.
      const encodingData = decoded.encoding !== "utf-8" || decoded.lossy
        ? { encoding: decoded.encoding, ...(decoded.lossy ? { encoding_lossy: true } : {}) } : {};
      const lines = content.split("\n");
      if (character_offset !== undefined && character_offset > (lines[(offset ?? 1) - 1]?.length ?? 0)) {
        throw new Error("character_offset is past the end of the starting line; use the continuation offsets from the preceding read.");
      }
      const includeApplicableInstructions = tail === undefined && (offset === undefined || offset <= 1) && !character_offset;
      const applicableInstructions = includeApplicableInstructions
        ? (await loadPathRulesForFile(workspaceRoot, validPath)).filter(
            (rule) => rule.path !== validPath && (rule.kind === "path_rule" || rule.depth > 0)
          )
        : [];
      const instructionData = applicableInstructions.length
        ? {
            applicable_instructions: applicableInstructions,
            applicable_instruction_count: applicableInstructions.length,
          }
        : {};

      if (offset !== undefined) {
        const start = Math.max(0, offset - 1);
        const end = limit !== undefined ? start + limit : lines.length;
        const bounded = boundedLines(lines, start, end, true, character_offset);
        await audit({ tool: "read_text_file", action: "read", target: validPath, status: "ok", details: { offset, limit } });
        return toolResult("read_text_file", {
          path: validPath,
          content: bounded.content,
          offset,
          character_offset: character_offset ?? 0,
          limit,
          lines: bounded.lines_read,
          total_lines: lines.length,
          truncated: bounded.truncated,
          next_offset: bounded.next_offset,
          next_character_offset: bounded.next_character_offset,
          single_line_truncated: bounded.single_line_truncated,
          ...encodingData,
          ...instructionData,
        });
      }

      if (tail !== undefined) {
        const bounded = boundedTail(lines, Math.max(0, Math.floor(tail)));
        await audit({ tool: "read_text_file", action: "read", target: validPath, status: "ok", details: { tail } });
        return toolResult("read_text_file", {
          path: validPath,
          content: bounded.content,
          tail,
          lines: bounded.lines_read,
          total_lines: lines.length,
          truncated: bounded.truncated,
          start_offset: bounded.start_offset,
          ...encodingData,
        });
      }

      const end = head !== undefined ? Math.min(lines.length, Math.max(0, Math.floor(head))) : lines.length;
      const bounded = boundedLines(lines, 0, end, false);
      await audit({ tool: "read_text_file", action: "read", target: validPath, status: "ok" });
      return toolResult("read_text_file", {
        path: validPath,
        content: bounded.content,
        head,
        lines: bounded.lines_read,
        total_lines: lines.length,
        truncated: bounded.truncated,
        next_offset: bounded.next_offset,
        next_character_offset: bounded.next_character_offset,
        single_line_truncated: bounded.single_line_truncated,
        ...encodingData,
        ...instructionData,
      });
    }
  );

  server.registerTool(
    "read_file_base64",
    {
      title: "Read File Base64",
      description: "Read a local file as base64. Prefer <= 64 KiB chunks; hard max 1 MiB before Base64/JSON encoding. Retain next_offset and verify final hashes. Do not return a whole large artifact inline.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().nonnegative().optional().default(0),
        length: z.number().int().positive().max(MAX_BINARY_CHUNK_BYTES).optional().default(64 * 1024),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, offset, length }) => {
      const validPath = await validatePath(filePath);
      const stat = await fs.stat(validPath);
      if (!stat.isFile()) throw new Error("Path is not a regular file");
      const start = Math.min(offset, stat.size);
      const chunkLength = Math.min(length, MAX_BINARY_CHUNK_BYTES, stat.size - start);
      const handle = await fs.open(validPath, "r");
      try {
        const buffer = Buffer.alloc(chunkLength);
        const { bytesRead } = await handle.read(buffer, 0, chunkLength, start);
        const data = buffer.subarray(0, bytesRead);
        const nextOffset = start + bytesRead;
        await audit({ tool: "read_file_base64", action: "read", target: validPath, status: "ok", details: { offset: start, bytesRead } });
        return toolResult("read_file_base64", {
          path: validPath,
          size: stat.size,
          offset: start,
          bytes_read: bytesRead,
          next_offset: nextOffset < stat.size ? nextOffset : null,
          done: nextOffset >= stat.size,
          encoding: "base64",
          content: data.toString("base64"),
        });
      } finally {
        await handle.close();
      }
    }
  );

  server.registerTool(
    "file_info",
    {
      title: "File Info",
      description:
        "Inspect a local path without modifying it. For files, optionally calculate SHA256 and return leading bytes so callers can verify real file type/signature instead of trusting the extension.",
      inputSchema: {
        path: z.string(),
        sha256: z.boolean().optional().default(false),
        head_bytes: z.number().int().nonnegative().max(64).optional().default(16),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, sha256, head_bytes }) => {
      const validPath = await validatePath(filePath);
      const stat = await fs.lstat(validPath);
      const type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
      const head = stat.isFile() ? await readHead(validPath, head_bytes) : Buffer.alloc(0);
      let digest: string | undefined;
      if (stat.isFile()) {
        if (sha256) digest = await sha256File(validPath);
      }
      await audit({ tool: "file_info", action: "stat", target: validPath, status: "ok" });
      return toolResult("file_info", {
        path: validPath,
        type,
        size: stat.size,
        extension: stat.isFile() ? path.extname(validPath).toLowerCase() : "",
        created_at: stat.birthtime.toISOString(),
        modified_at: stat.mtime.toISOString(),
        accessed_at: stat.atime.toISOString(),
        detected_type: stat.isFile() ? detectFileType(head) : null,
        first_bytes_hex: stat.isFile() ? head.toString("hex").toUpperCase() : "",
        sha256: digest,
      });
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: "Save text to a local file using a canonical per-file write queue and temporary-file publication. Supply expected_sha256 to reject lost updates when the caller read an earlier version; create_only rejects an existing target.",
      inputSchema: {
        path: z.string(),
        content: z.string(),
        expected_sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional().describe("SHA256 of the current file version that this write is allowed to replace"),
        create_only: z.boolean().optional().default(false).describe("Fail rather than overwrite when the target already exists"),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, content, expected_sha256, create_only }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      let checkpointId: string | undefined;
      let checkpoint: Awaited<ReturnType<typeof checkpointBeforeDetailed>> | undefined;
      const write = await writeTextFileCas(validPath, content, {
        expectedSha256: expected_sha256,
        createOnly: create_only,
        beforePublish: async () => {
          checkpoint = await checkpointBeforeDetailed("write_file", [validPath]);
          checkpointId = checkpoint.id ?? undefined;
        },
      });
      await audit({
        tool: "write_file",
        action: "write",
        target: validPath,
        status: "ok",
        details: {
          bytes: write.bytes,
          previous_sha256: write.previous_sha256,
          sha256: write.sha256,
          expected_sha256_checked: write.expected_sha256_checked,
          create_only_checked: write.create_only_checked,
          publish_strategy: write.publish_strategy,
        },
      });
      const data = await enrichAfterEdit(
        { path: validPath, ...write, checkpoint_id: checkpointId, checkpoint },
        [validPath]
      );
      return toolResult("write_file", data);
    }
  );

  server.registerTool(
    "write_file_base64",
    {
      title: "Write File Base64",
      description:
        "Create or update a binary file from strict base64. For multi-chunk transfers, provide expected_size on every chunk. Start with truncate=true, offset=0; include the returned transfer_id and next_offset on subsequent calls and retries, with the same expected_size and optional expected_sha256. The transfer publishes only when complete and the target has not changed. A retry of the first request without its transfer_id starts a separate transfer. Prefer chunks <= 256 KiB.",
      inputSchema: {
        path: z.string(),
        content: z.string().max(MAX_BASE64_CHARS),
        offset: z.number().int().nonnegative().optional().default(0),
        truncate: z.boolean().optional().default(true),
        expected_size: z.number().int().nonnegative().optional(),
        expected_sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional(),
        transfer_id: z.string().uuid().optional().describe("Transfer ID returned by the first staged chunk; required on every continuation and retry"),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, content, offset, truncate, expected_size, expected_sha256, transfer_id }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      if (truncate && offset !== 0) {
        throw new Error("truncate=true requires offset=0");
      }

      const buffer = decodeBase64Strict(content);
      if (expected_size !== undefined && offset + buffer.length > expected_size) {
        throw new Error(
          `Chunk exceeds expected_size: offset ${offset} + ${buffer.length} bytes > ${expected_size}`
        );
      }

      if (expected_size !== undefined) {
        let checkpoint: Awaited<ReturnType<typeof checkpointBeforeDetailed>> | undefined;
        const result = await writeStagedBinary({ target: validPath, buffer, offset, truncate, expectedSize: expected_size,
          expectedHash: expected_sha256, transferId: transfer_id,
          checkpoint: async target => { checkpoint = await checkpointBeforeDetailed("write_file_base64", [target]); return checkpoint.id ?? undefined; } });
        await audit({ tool: "write_file_base64", action: "write", target: result.path, status: "ok", details: result });
        return toolResult("write_file_base64", { ...result, checkpoint });
      }
      if (transfer_id) throw new Error("UPLOAD_CONFLICT: transfer_id requires expected_size");
      return withCanonicalFileLock(validPath, async lockedPath => {
        const checkpoint = truncate ? await checkpointBeforeDetailed("write_file_base64", [lockedPath]) : undefined;
        const checkpointId = checkpoint?.id;
        await fs.mkdir(path.dirname(lockedPath), { recursive: true });
        let idempotentRetry = false;
        if (truncate) {
          const handle = await fs.open(lockedPath, "w");
          try { await writeAll(handle, buffer, 0); } finally { await handle.close(); }
        } else {
          let size = 0;
          try { size = (await fs.stat(lockedPath)).size; }
          catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
            if (offset !== 0) throw new Error(`Cannot write at offset ${offset}: target file does not exist`);
            await fs.writeFile(lockedPath, Buffer.alloc(0), { flag: "wx" });
          }
          if (offset > size) throw new Error(`Cannot write at offset ${offset}: current file size is ${size}`);
          const handle = await fs.open(lockedPath, "r+");
          try {
            if (offset < size) {
              if (offset + buffer.length > size) throw new Error("Chunk overlaps existing EOF");
              const existing = Buffer.alloc(buffer.length);
              const { bytesRead } = await handle.read(existing, 0, buffer.length, offset);
              if (bytesRead !== buffer.length || !existing.equals(buffer)) throw new Error(`Chunk conflict at offset ${offset}`);
              idempotentRetry = true;
            } else await writeAll(handle, buffer, offset);
          } finally { await handle.close(); }
        }
        const stat = await fs.stat(lockedPath);
        let sha256: string | undefined;
        if (expected_sha256) {
          sha256 = await sha256File(lockedPath);
          if (sha256.toLowerCase() !== expected_sha256.toLowerCase()) throw new Error(`SHA256 mismatch: expected ${expected_sha256.toLowerCase()}, got ${sha256}`);
        }
        const result = { path: lockedPath, bytes_written: idempotentRetry ? 0 : buffer.length, offset, next_offset: stat.size,
          file_size: stat.size, expected_size, sha256, finalized: false, idempotent_retry: idempotentRetry, checkpoint_id: checkpointId, checkpoint };
        await audit({ tool: "write_file_base64", action: "write", target: lockedPath, status: "ok", details: result });
        return toolResult("write_file_base64", result);
      });
    }
  );

  server.registerTool(
    "save_chatgpt_file",
    {
      title: "Save ChatGPT File",
      description:
        "Save a real ChatGPT attachment or generated conversation file to Windows using the host-authorized file reference, not a sandbox link or Base64. Call this before claiming local delivery; return finalized path/bytes/SHA256 and verify them. Streams to a unique temporary file and publishes only after completion. Maximum 512 MiB, default total download timeout 120 seconds, configurable to 900 seconds; the ChatGPT caller may have a shorter deadline. No durable resume. A failed download is not a saved file.",
      inputSchema: {
        file: chatGptFileSchema.describe("A ChatGPT conversation attachment. Do not manually construct this object or copy file bytes into it."),
        path: z.string().optional().describe("Destination local path. Relative paths resolve from WORKSPACE_PATH. Defaults to the attachment file name."),
        timeout_ms: z.number().int().min(1000).max(MAX_CHATGPT_FILE_TIMEOUT_MS).optional().describe("Total download deadline, including all redirects and the body. Default 120000, starts after filesystem lock/checkpoint preparation. Does not extend the ChatGPT tool-call deadline."),
        expected_sha256: z.string().regex(/^[A-Fa-f0-9]{64}$/).optional().describe("Expected SHA256 of the original bytes when available; rejects corruption before publication."),
      },
      _meta: { "openai/fileParams": ["file"] },
      annotations: toolAnnotations("edit"),
    },
    async ({ file, path: destinationPath, timeout_ms, expected_sha256 }, extra) => {
      extra?.signal?.throwIfAborted();
      requireWriteAllowed();
      if (file.size !== undefined && file.size > MAX_CHATGPT_FILE_BYTES) {
        throw new Error(`CHATGPT_FILE_TOO_LARGE: metadata reports ${file.size} bytes; limit=${MAX_CHATGPT_FILE_BYTES}`);
      }
      const requestedPath = destinationPath?.trim() || fallbackFileName(file);
      const validPath = await validatePath(requestedPath);
      extra?.signal?.throwIfAborted();
      return withCanonicalFileLock(validPath, async (lockedPath) => {
      extra?.signal?.throwIfAborted();
      const stagingPath = `${lockedPath}.${process.pid}.${randomUUID()}.part`;
      const checkpoint = await checkpointBeforeDetailed("save_chatgpt_file", [lockedPath]);
      const checkpointId = checkpoint.id;
      extra?.signal?.throwIfAborted();
      const timeoutMs = timeout_ms ?? DEFAULT_CHATGPT_FILE_TIMEOUT_MS;
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (extra?.signal) signals.push(extra.signal);
      const signal = AbortSignal.any(signals);
      const startedAt = Date.now();
      let phase = "connect";
      let downloadedBytes = 0;
      let response: Response | undefined;

      let finalUrlHost: string | undefined = new URL(file.download_url).hostname;
      try {
        signal.throwIfAborted();
        const fetched = await fetchChatGptFile(file.download_url, signal, dependencies.fetchResponse);
        response = fetched.response;
        finalUrlHost = new URL(fetched.finalUrl).hostname;
        phase = "headers";
        const contentLengthRaw = fetched.response.headers.get("content-length");
        const contentLength = contentLengthRaw ? Number(contentLengthRaw) : undefined;
        if (contentLength !== undefined && Number.isFinite(contentLength) && contentLength > MAX_CHATGPT_FILE_BYTES) {
          throw new Error(`ChatGPT file is ${contentLength} bytes, above the ${MAX_CHATGPT_FILE_BYTES} byte safety limit`);
        }
        if (file.size !== undefined && file.size > MAX_CHATGPT_FILE_BYTES) {
          throw new Error(`ChatGPT file metadata reports ${file.size} bytes, above the ${MAX_CHATGPT_FILE_BYTES} byte safety limit`);
        }

        phase = "download";
        const { bytes, sha256 } = await streamResponseBodyToFile(fetched.response, stagingPath, MAX_CHATGPT_FILE_BYTES,
          { signal, exclusive: true, onProgress: (value) => { downloadedBytes = value; } });
        phase = "verify";
        if (file.size !== undefined && bytes !== file.size) {
          throw new Error(`ChatGPT file size mismatch: metadata says ${file.size} bytes, downloaded ${bytes}`);
        }
        const encoding = fetched.response.headers.get("content-encoding")?.trim().toLowerCase();
        if ((!encoding || encoding === "identity") && contentLength !== undefined && Number.isFinite(contentLength) && bytes !== contentLength) {
          throw new Error(`ChatGPT file size mismatch: HTTP Content-Length says ${contentLength} bytes, downloaded ${bytes}`);
        }

        if (expected_sha256 && sha256 !== expected_sha256.toLowerCase()) {
          throw new Error(`CHATGPT_FILE_HASH_MISMATCH: expected=${expected_sha256.toLowerCase()}; actual=${sha256}`);
        }
        // Optional metadata reads must finish before the irreversible commit.
        // A read-sharing error must never label an already-published file failed.
        const head = await readHead(stagingPath, 16);
        signal.throwIfAborted();
        requireWriteAllowed();
        phase = "publish";
        await fs.rename(stagingPath, lockedPath);
        await audit({
          tool: "save_chatgpt_file",
          action: "write",
          target: lockedPath,
          status: "ok",
          details: { file_id: file.file_id, bytes, sha256, mime_type: file.mime_type, final_url_host: finalUrlHost, elapsed_ms: Date.now() - startedAt },
        });
        return toolResult("save_chatgpt_file", {
          path: lockedPath,
          file_id: file.file_id,
          source_name: file.file_name ?? file.name,
          mime_type: file.mime_type,
          size: bytes,
          sha256,
          detected_type: detectFileType(head),
          first_bytes_hex: head.toString("hex").toUpperCase(),
          finalized: true,
          download_timeout_ms: timeoutMs,
          max_file_bytes: MAX_CHATGPT_FILE_BYTES,
          elapsed_ms: Date.now() - startedAt,
          checkpoint_id: checkpointId, checkpoint,
        });
      } catch (error) {
        await response?.body?.cancel().catch(() => undefined);
        const failure = describeChatGptTransferError(error);
        let cleanupError: string | undefined;
        try { await fs.rm(stagingPath, { force: true }); }
        catch (cleanup) { cleanupError = describeChatGptTransferError(cleanup).code; }
        await audit({
          tool: "save_chatgpt_file",
          action: "write",
          target: validPath,
          status: "error",
          details: { file_id: file.file_id, final_url_host: finalUrlHost, error: failure.message, code: failure.code,
            phase, downloaded_bytes: downloadedBytes, elapsed_ms: Date.now() - startedAt,
            timeout_ms: timeoutMs, max_file_bytes: MAX_CHATGPT_FILE_BYTES, cleanup_error: cleanupError },
        });
        throw new Error(`CHATGPT_FILE_TRANSFER_FAILED: phase=${phase}; code=${failure.code}; host=${finalUrlHost}; downloaded_bytes=${downloadedBytes}; timeout_ms=${timeoutMs}; limit_bytes=${MAX_CHATGPT_FILE_BYTES}. ${failure.message}`);
      }
      });
    }
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit File",
      description: "Apply exact text replacement to a file. Returns diff.",
      inputSchema: {
        path: z.string(),
        old_text: z.string(),
        new_text: z.string(),
        replace_all: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, old_text, new_text, replace_all, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const snapshot = await readFileForEdit(validPath);
      const decoded = decodeText(snapshot.bytes);
      const content = decoded.text;
      if (!content.includes(old_text)) throw new Error("old_text not found in file. Ensure exact match.");
      // A replacer function keeps "$&", "$'" and "$$" in new_text literal.
      const newContent = replace_all ? content.split(old_text).join(new_text) : content.replace(old_text, () => new_text);
      const diff = buildSimpleDiff(content, newContent);
      const output = dry_run ? null : editedBytes(decoded, newContent, validPath);
      const checkpoint = await publishEditWithCheckpoint("edit_file", filePath, validPath, snapshot, output, dry_run);
      const checkpointId = checkpoint.id;
      await audit({ tool: "edit_file", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok" });
      const data = await enrichAfterEdit({ path: validPath, diff, dry_run, checkpoint_id: checkpointId, checkpoint, ...encodingNote(decoded) }, [validPath], dry_run);
      return toolResult("edit_file", data, { summary: dry_run ? `dry-run ${validPath}` : `edited ${validPath}` });
    }
  );

  server.registerTool(
    "multi_edit",
    {
      title: "Multi Edit",
      description: "Apply multiple exact replacements to one text file atomically.",
      inputSchema: {
        path: z.string(),
        edits: z.array(z.object({ old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional().default(false) })),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, edits, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const snapshot = await readFileForEdit(validPath);
      const decoded = decodeText(snapshot.bytes);
      const original = decoded.text;
      let next = original;
      for (const edit of edits) {
        if (!next.includes(edit.old_text)) throw new Error(`old_text not found: ${edit.old_text.slice(0, 120)}`);
        next = edit.replace_all ? next.split(edit.old_text).join(edit.new_text) : next.replace(edit.old_text, () => edit.new_text);
      }
      const diff = buildSimpleDiff(original, next);
      const output = dry_run ? null : editedBytes(decoded, next, validPath);
      const checkpoint = await publishEditWithCheckpoint("multi_edit", filePath, validPath, snapshot, output, dry_run);
      const checkpointId = checkpoint.id;
      await audit({ tool: "multi_edit", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok", details: { edits: edits.length } });
      const data = await enrichAfterEdit(
        { path: validPath, diff, edits: edits.length, dry_run, checkpoint_id: checkpointId, checkpoint, ...encodingNote(decoded) },
        [validPath],
        dry_run
      );
      return toolResult("multi_edit", data);
    }
  );

  server.registerTool(
    "replace_regex",
    {
      title: "Replace Regex",
      description: "Apply a JavaScript regex replacement to a text file.",
      inputSchema: { path: z.string(), pattern: z.string(), replacement: z.string(), flags: z.string().optional().default("g"), dry_run: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, pattern, replacement, flags, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const snapshot = await readFileForEdit(validPath);
      const decoded = decodeText(snapshot.bytes);
      const original = decoded.text;
      const regex = new RegExp(pattern, flags);
      // A catastrophic pattern must fail this call, not freeze the server.
      const next = replaceWithDeadline(original, regex, replacement, 10_000);
      if (next === original) throw new Error("Regex made no changes.");
      const diff = buildSimpleDiff(original, next);
      const output = dry_run ? null : editedBytes(decoded, next, validPath);
      const checkpoint = await publishEditWithCheckpoint("replace_regex", filePath, validPath, snapshot, output, dry_run);
      const checkpointId = checkpoint.id;
      await audit({ tool: "replace_regex", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok" });
      return toolResult("replace_regex", { path: validPath, diff, dry_run, checkpoint_id: checkpointId, checkpoint, ...encodingNote(decoded) });
    }
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Preferred way to edit code. Codex @@ hunks or *** Begin Patch format. Read the file first. Use dry_run:true to preview.",
      inputSchema: {
        path: z.string().optional().describe("Target file (single-file) or base directory (multi-file)"),
        patch: z.string(),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, patch, dry_run }) => {
      requireWriteAllowed();

      // A unified diff with ---/+++ headers addressed to one named file is a
      // single-file patch on that file, whatever prefix its headers use.
      let singleFileTarget = false;
      if (filePath && isMultiFilePatch(patch) && !/^\*\*\* /m.test(patch)) {
        const stat = await fs.stat(await validatePath(filePath)).catch(() => null);
        const sections = stat?.isFile() ? parseMultiFilePatch(patch) : [];
        singleFileTarget = sections.length === 1 && sections[0].operation === "update" && !sections[0].moveTo;
      }

      if (isMultiFilePatch(patch) && !singleFileTarget) {
        // Relative patch paths are workspace paths, never the server's own
        // process folder (the desktop runtime directory with .env and profiles).
        let baseDir: string = getDefaultCwd();
        if (filePath) {
          const validPath = await validatePath(filePath);
          const stat = await fs.stat(validPath);
          baseDir = stat.isDirectory() ? validPath : path.dirname(validPath);
        }
        const patchPaths = parseMultiFilePatch(patch, baseDir).flatMap((op) => op.moveTo ? [op.path, op.moveTo] : [op.path]);
        for (const target of patchPaths) await validatePath(target);
        const checkpoint = await checkpointBeforeDetailed("apply_patch", patchPaths, { dry_run });
        const checkpointId = checkpoint.id;
        const results = await applyMultiFilePatch(patch, { base_dir: baseDir, dry_run,
          before_commit: async target => { requireWriteAllowed(); await validatePath(target); } });
        const failed = results.filter((r) => !r.ok);
        await audit({
          tool: "apply_patch",
          action: "patch",
          target: baseDir || "multi",
          status: failed.length ? "error" : dry_run ? "dry-run" : "ok",
          details: { files: results.length, failed: failed.length },
        });
        const okPaths = results.filter((r) => r.ok && r.path).map((r) => r.path as string);
        const payload = await enrichAfterEdit(
          { files: results, dry_run, multi_file: true, checkpoint_id: checkpointId, checkpoint },
          okPaths,
          dry_run
        );
        return toolResult("apply_patch", payload, {
          ok: failed.length === 0,
          summary: `patched ${results.length} file(s)${failed.length ? `, ${failed.length} failed` : ""}`,
        });
      }

      if (!filePath) throw new Error("path is required for single-file patches");
      const validPath = await validatePath(filePath);
      const snapshot = await readFileForEdit(validPath);
      const decoded = decodeText(snapshot.bytes);
      const original = decoded.text;
      const next = applyUnifiedPatchToText(original, patch);
      const diff = buildSimpleDiff(original, next);
      const output = dry_run ? null : editedBytes(decoded, next, validPath);
      const checkpoint = await publishEditWithCheckpoint("apply_patch", filePath, validPath, snapshot, output, dry_run);
      const checkpointId = checkpoint.id;
      await audit({ tool: "apply_patch", action: "patch", target: validPath, status: dry_run ? "dry-run" : "ok" });
      const data = await enrichAfterEdit({ path: validPath, diff, dry_run, checkpoint_id: checkpointId, checkpoint, ...encodingNote(decoded) }, [validPath], dry_run);
      return toolResult("apply_patch", data);
    }
  );

  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description: "List files and directories in a path. Claude LS equivalent with optional ignore globs.",
      inputSchema: {
        path: z.string(),
        ignore: z.array(z.string()).optional().describe("Glob patterns to ignore, e.g. node_modules, *.log"),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: dirPath, ignore }) => {
      const validPath = await validatePath(dirPath);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      const ignoreMatchers = (ignore || []).map(
        (p) => new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i")
      );
      const filtered = entries
        .filter((e) => !ignoreMatchers.some((m) => m.test(e.name)))
        .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name));
      const items = filtered
        .slice(0, MAX_DIRECTORY_ENTRIES)
        .map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      await audit({ tool: "list_directory", action: "list", target: validPath, status: "ok" });
      return toolResult("list_directory", {
        path: validPath,
        entries: items,
        count: items.length,
        total_entries: filtered.length,
        truncated: filtered.length > items.length,
        omitted_entries: Math.max(0, filtered.length - items.length),
      });
    }
  );

  server.registerTool(
    "glob",
    {
      title: "Glob",
      description: "Explore: find files by name pattern under a directory. Use before read_text_file when you do not know exact paths.",
      inputSchema: {
        pattern: z.string().describe('Glob pattern like "**/*.ts" or "src/**/*.tsx"'),
        path: z.string().optional().describe("Directory to search in; defaults to workspace root context"),
        max_results: z.number().int().positive().max(500).optional().default(100),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ pattern, path: searchPath, max_results }) => {
      const validPath = searchPath ? await validatePath(searchPath) : (await import("../lib/path-security.js")).getAllowedRoots()[0];
      const matches = await globFiles(validPath, pattern, max_results);
      await audit({ tool: "glob", action: "glob", target: validPath, status: "ok", details: { pattern, results: matches.length } });
      return toolResult("glob", { path: validPath, pattern, matches: matches.map((m) => m.path), count: matches.length });
    }
  );

  server.registerTool(
    "grep",
    {
      title: "Grep",
      description: "Explore: search file contents by regex. Prefer over reading many files blindly. Modes: content, files_with_matches, count.",
      inputSchema: {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional().default("*"),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional().default("content"),
        offset: z.number().int().nonnegative().max(100000).optional().default(0).describe("Result-row offset for deterministic continuation; use next_offset from the previous page"),
        case_insensitive: z.boolean().optional().default(false),
        multiline: z.boolean().optional().default(false),
        head_limit: z.number().int().positive().max(1000).optional().default(200).describe("Maximum result rows: 1–1000; default 200"),
        context_before: z.number().int().nonnegative().max(20).optional().default(0).describe("Context lines before each match: 0–20"),
        context_after: z.number().int().nonnegative().max(20).optional().default(0).describe("Context lines after each match: 0–20"),
        context_around: z.number().int().nonnegative().max(20).optional().default(0).describe("Context lines on each side of a match: 0–20"),
      },

      annotations: toolAnnotations("read"),
    },
    async ({
      pattern,
      path: searchPath,
      glob: globPattern,
      output_mode,
      offset,
      case_insensitive,
      multiline,
      head_limit,
      context_before,
      context_after,
      context_around,
    }) => {
      const validPath = searchPath ? await validatePath(searchPath) : (await import("../lib/path-security.js")).getAllowedRoots()[0];
      const page = await grepSearchPage({
        pattern,
        path: validPath,
        glob: globPattern,
        outputMode: output_mode,
        offset,
        caseInsensitive: case_insensitive,
        multiline,
        headLimit: head_limit,
        contextBefore: context_before,
        contextAfter: context_after,
        contextAround: context_around,
      });
      await audit({ tool: "grep", action: "grep", target: validPath, status: "ok", details: { pattern, output_mode } });
      return toolResult("grep", { path: validPath, pattern, output_mode, ...page });
    }
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete File",
      description: "Delete a file from the filesystem.",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("destructive"),
    },
    async ({ path: filePath }) => deletePhysicalPath("delete_file", filePath, false)
  );

  server.registerTool(
    "create_directory",
    {
      title: "Create Directory",
      description: "Create a directory (and parents if needed).",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(dirPath);
      await fs.mkdir(validPath, { recursive: true });
      await audit({ tool: "create_directory", action: "mkdir", target: validPath, status: "ok" });
      return toolResult("create_directory", { path: validPath });
    }
  );

  server.registerTool(
    "delete_directory",
    {
      title: "Remove Local Folder",
      description:
        "Remove a folder from the local workspace (user-specified path). Does not affect remote servers.",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("destructive"),
    },
    async ({ path: dirPath }) => deletePhysicalPath("delete_directory", dirPath, true)
  );

  server.registerTool(
    "copy_file",
    {
      title: "Copy File",
      description: "Copy a file to a new location.",
      inputSchema: { source: z.string(), destination: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ source, destination }) => {
      requireWriteAllowed();
      const src = await validatePath(source);
      const dest = await validatePath(destination);
      const stat = await fs.stat(src);
      if (!stat.isFile()) throw new Error("Source is not a file");
      const checkpoint = await checkpointBeforeDetailed("copy_file", [dest]);
      const checkpointId = checkpoint.id;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      await audit({ tool: "copy_file", action: "copy", target: dest, status: "ok", details: { source: src } });
      return toolResult("copy_file", { source: src, destination: dest, checkpoint_id: checkpointId, checkpoint });
    }
  );

  server.registerTool(
    "move_file",
    {
      title: "Move File",
      description: "Move or rename a file or directory.",
      inputSchema: { source: z.string(), destination: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ source, destination }) => {
      requireWriteAllowed();
      const src = await validatePath(source);
      const dest = await validatePath(destination);
      const checkpoint = await checkpointBeforeDetailed("move_file", [src, dest]);
      const checkpointId = checkpoint.id;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fs.rename(src, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        const stat = await fs.stat(src);
        if (stat.isDirectory()) {
          await fs.cp(src, dest, { recursive: true, force: true });
          await fs.rm(src, { recursive: true, force: true });
        } else if (stat.isFile()) {
          await fs.copyFile(src, dest);
          const copied = await fs.stat(dest);
          if (copied.size !== stat.size) {
            throw new Error(`Cross-volume copy verification failed: ${copied.size} != ${stat.size}`);
          }
          await fs.unlink(src);
        } else {
          throw new Error("Cross-volume move supports files and directories only");
        }
      }
      await audit({ tool: "move_file", action: "move", target: dest, status: "ok", details: { source: src } });
      return toolResult("move_file", { source: src, destination: dest, checkpoint_id: checkpointId, checkpoint });
    }
  );

  server.registerTool("search_files", { title: "Search Files", description: "Search file contents for a text pattern with deterministic offset continuation.", inputSchema: { path: z.string(), pattern: z.string(), glob: z.string().optional().default("*"), offset: z.number().int().nonnegative().max(100000).optional().default(0), max_results: z.number().int().positive().max(500).optional().default(50) }, annotations: toolAnnotations("read") }, async ({ path: searchPath, pattern, glob: globPattern, offset, max_results }) => {
    const validPath = await validatePath(searchPath);
    const page = await searchDirectoryPage(validPath, pattern, globPattern, offset, max_results);
    await audit({ tool: "search_files", action: "search", target: validPath, status: "ok", details: { pattern, results: page.matches.length, offset } });
    return toolResult("search_files", { path: validPath, pattern, ...page, count: page.matches.length });
  });

  server.registerTool("directory_tree", { title: "Directory Tree", description: "Get recursive directory structure as JSON.", inputSchema: { path: z.string(), max_depth: z.number().optional().default(4) }, annotations: toolAnnotations("read") }, async ({ path: dirPath, max_depth }) => {
    const validPath = await validatePath(dirPath);
    const tree = await buildTree(validPath, 0, max_depth);
    await audit({ tool: "directory_tree", action: "tree", target: validPath, status: "ok" });
    return toolResult("directory_tree", { path: validPath, tree, max_depth });
  });

  server.registerTool("list_allowed_directories", { title: "List Allowed Directories", description: "Show default working directory and machine access scope.", inputSchema: {}, annotations: toolAnnotations("read") }, async () => {
    const { getDefaultCwd, getMachineRoots } = await import("../lib/path-security.js");
    const { describePermissionProfile } = await import("../lib/permissions.js");
    const machineRoots = getMachineRoots();
    return toolResult("list_allowed_directories", {
      full_machine_access: true,
      permission: describePermissionProfile(),
      default_cwd: getDefaultCwd(),
      machine_roots: machineRoots,
    });
  });
}
