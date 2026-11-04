import path from "path";
import { createHash } from "node:crypto";

const MAX_CHUNK_CHARS = 2_400;
const MAX_CHUNK_LINES = 60;
const MAX_HEADINGS_PER_FILE = 40;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "this",
  "to",
  "with",
  "what",
  "一个",
  "进行",
  "这个",
  "需要",
  "项目",
  "帮我",
]);

const TERM_ALIASES: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /矢量图|矢量|向量图/u, terms: ["svg", "vector"] },
  { pattern: /渲染|预览|截图/u, terms: ["render", "preview", "screenshot"] },
  { pattern: /几何|布局|排版/u, terms: ["geometry", "layout"] },
  { pattern: /裁切|裁剪|溢出/u, terms: ["clipping", "crop", "overflow"] },
  { pattern: /发布|发行/u, terms: ["release", "changelog", "tag"] },
  { pattern: /构建|编译/u, terms: ["build", "compile"] },
  { pattern: /测试|验证|验收/u, terms: ["test", "verify", "validation"] },
  { pattern: /错误|失败|故障/u, terms: ["error", "failure", "bug"] },
  { pattern: /认证|鉴权|权限/u, terms: ["auth", "oauth", "permission"] },
  { pattern: /浏览器|网页/u, terms: ["browser", "web", "html"] },
  { pattern: /图片|图像/u, terms: ["image", "png", "jpeg"] },
  { pattern: /文档|说明/u, terms: ["docs", "documentation", "readme"] },
  { pattern: /代码|源码/u, terms: ["code", "source"] },
];

export interface ContextSourceFile {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
  source_sha256?: string;
}

export interface ContextHeading {
  line: number;
  text: string;
}

export interface ContextFileMapEntry {
  path: string;
  relative_path: string;
  bytes: number;
  loaded_bytes: number;
  truncated: boolean;
  source_sha256: string;
  headings: ContextHeading[];
}

export interface ContextExportManifestEntry {
  relative_path: string;
  source_sha256: string;
  bytes: number;
  loaded_bytes: number;
  truncated: boolean;
  reason: string;
}

export interface ContextExportManifest {
  revision: string;
  included: ContextExportManifestEntry[];
  skipped: ContextExportManifestEntry[];
  truncated: ContextExportManifestEntry[];
  limits: { max_total_bytes: number; max_chunks: number };
}

export interface RelevantContextChunk {
  path: string;
  relative_path: string;
  start_line: number;
  end_line: number;
  heading?: string;
  content: string;
  score: number;
  matched_terms: string[];
}

interface InternalChunk extends RelevantContextChunk {
  normalized_content: string;
  normalized_heading: string;
  normalized_path: string;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function relativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") ? relative : filePath;
}

function sourceSha256(source: ContextSourceFile): string {
  return source.source_sha256 ?? createHash("sha256").update(source.content, "utf8").digest("hex");
}

function sourceRevision(root: string, files: ContextSourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => relativePath(root, left.path).localeCompare(relativePath(root, right.path)))) {
    hash.update(relativePath(root, file.path));
    hash.update("\0");
    hash.update(sourceSha256(file));
    hash.update("\0");
    hash.update(String(file.bytes));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function instructionPriority(filePath: string): number {
  const base = path.basename(filePath).toLowerCase();
  if (base === "agents.md" || base === "claude.md" || base === "claude.local.md") return 8;
  if (base === "readme.md") return 3;
  if (base.endsWith(".toml") || base.endsWith(".json") || base.includes("settings")) return 2;
  return 0;
}

function queryTerms(query: string): string[] {
  const normalized = normalize(query);
  const terms = new Set<string>();

  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_.\/-]{1,}/g)) {
    const term = match[0];
    if (!STOP_WORDS.has(term)) terms.add(term);
  }

  for (const match of normalized.matchAll(/[\u3400-\u9fff]{2,}/g)) {
    const block = match[0];
    if (!STOP_WORDS.has(block)) terms.add(block);
    if (block.length > 2) {
      for (let index = 0; index < block.length - 1; index++) {
        const bigram = block.slice(index, index + 2);
        if (!STOP_WORDS.has(bigram)) terms.add(bigram);
      }
    }
  }

  for (const alias of TERM_ALIASES) {
    if (!alias.pattern.test(normalized)) continue;
    for (const term of alias.terms) terms.add(term);
  }

  return [...terms].slice(0, 40);
}

function countOccurrences(text: string, term: string, cap = 6): number {
  let count = 0;
  let offset = 0;
  while (count < cap) {
    const index = text.indexOf(term, offset);
    if (index < 0) break;
    count++;
    offset = index + Math.max(1, term.length);
  }
  return count;
}

function extractHeadings(content: string): ContextHeading[] {
  const headings: ContextHeading[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    headings.push({ line: index + 1, text: match[1].trim() });
    if (headings.length >= MAX_HEADINGS_PER_FILE) break;
  }
  return headings;
}

function pushLineWindows(
  chunks: InternalChunk[],
  root: string,
  source: ContextSourceFile,
  lines: string[],
  startIndex: number,
  endIndex: number,
  heading?: string
): void {
  let windowStart = startIndex;
  let chars = 0;

  const flush = (exclusiveEnd: number) => {
    if (exclusiveEnd <= windowStart) return;
    const content = lines.slice(windowStart, exclusiveEnd).join("\n").trim();
    if (!content) {
      windowStart = exclusiveEnd;
      chars = 0;
      return;
    }
    const rel = relativePath(root, source.path);
    chunks.push({
      path: source.path,
      relative_path: rel,
      start_line: windowStart + 1,
      end_line: exclusiveEnd,
      ...(heading ? { heading } : {}),
      content,
      score: 0,
      matched_terms: [],
      normalized_content: normalize(content),
      normalized_heading: normalize(heading ?? ""),
      normalized_path: normalize(rel),
    });
    windowStart = exclusiveEnd;
    chars = 0;
  };

  for (let index = startIndex; index < endIndex; index++) {
    chars += lines[index].length + 1;
    const lineCount = index - windowStart + 1;
    if (chars >= MAX_CHUNK_CHARS || lineCount >= MAX_CHUNK_LINES) {
      flush(index + 1);
    }
  }
  flush(endIndex);
}

function chunksForFile(root: string, source: ContextSourceFile): InternalChunk[] {
  const chunks: InternalChunk[] = [];
  const lines = source.content.split(/\r?\n/);
  const headings: Array<{ index: number; text: string }> = [];

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (match) headings.push({ index, text: match[1].trim() });
  }

  if (headings.length === 0) {
    pushLineWindows(chunks, root, source, lines, 0, lines.length);
    return chunks;
  }

  if (headings[0].index > 0) {
    pushLineWindows(chunks, root, source, lines, 0, headings[0].index);
  }
  for (let index = 0; index < headings.length; index++) {
    const start = headings[index].index;
    const end = headings[index + 1]?.index ?? lines.length;
    pushLineWindows(chunks, root, source, lines, start, end, headings[index].text);
  }
  return chunks;
}

function scoreChunk(chunk: InternalChunk, query: string, terms: string[]): InternalChunk {
  const matched = new Set<string>();
  let score = instructionPriority(chunk.path);
  const normalizedQuery = normalize(query.trim());

  if (normalizedQuery.length >= 3 && chunk.normalized_content.includes(normalizedQuery)) {
    score += 20;
  }

  for (const term of terms) {
    const headingHits = countOccurrences(chunk.normalized_heading, term, 2);
    const pathHits = countOccurrences(chunk.normalized_path, term, 2);
    const contentHits = countOccurrences(chunk.normalized_content, term);
    if (headingHits + pathHits + contentHits === 0) continue;
    matched.add(term);
    score += headingHits * 7 + pathHits * 5 + contentHits * 1.5;
  }

  if (matched.size >= 2) score += Math.min(8, matched.size * 2);
  return { ...chunk, score, matched_terms: [...matched] };
}

export function buildContextMap(root: string, files: ContextSourceFile[]): ContextFileMapEntry[] {
  return files.map((file) => ({
    path: file.path,
    relative_path: relativePath(root, file.path),
    bytes: file.bytes,
    loaded_bytes: Buffer.byteLength(file.content, "utf-8"),
    truncated: file.truncated,
    source_sha256: sourceSha256(file),
    headings: extractHeadings(file.content),
  }));
}

export function selectRelevantContext(
  root: string,
  files: ContextSourceFile[],
  query: string,
  options?: { maxTotalBytes?: number; maxChunks?: number }
): {
  query: string;
  query_terms: string[];
  files: ContextFileMapEntry[];
  chunks: RelevantContextChunk[];
  total_bytes: number;
  omitted_chunks: number;
  omitted_files: number;
  export_manifest: ContextExportManifest;
} {
  const terms = queryTerms(query);
  const maxTotalBytes = Math.max(2_000, options?.maxTotalBytes ?? 12_000);
  const maxChunks = Math.max(1, Math.min(options?.maxChunks ?? 10, 24));
  const scored = files
    .flatMap((file) => chunksForFile(root, file))
    .map((chunk) => scoreChunk(chunk, query, terms))
    .sort((left, right) =>
      right.score - left.score ||
      left.relative_path.localeCompare(right.relative_path) ||
      left.start_line - right.start_line
    );

  const selected: InternalChunk[] = [];
  const selectedKeys = new Set<string>();
  const perFile = new Map<string, number>();
  let totalBytes = 0;

  const addChunk = (chunk: InternalChunk): boolean => {
    const key = `${chunk.path}:${chunk.start_line}:${chunk.end_line}`;
    if (selectedKeys.has(key)) return false;
    if ((perFile.get(chunk.path) ?? 0) >= 3) return false;
    const bytes = Buffer.byteLength(chunk.content, "utf-8") + Buffer.byteLength(chunk.relative_path, "utf-8") + 120;
    if (selected.length > 0 && totalBytes + bytes > maxTotalBytes) return false;
    selected.push(chunk);
    selectedKeys.add(key);
    perFile.set(chunk.path, (perFile.get(chunk.path) ?? 0) + 1);
    totalBytes += bytes;
    return true;
  };

  const bestInstructionChunk = scored.find((chunk) => instructionPriority(chunk.path) >= 8);
  if (bestInstructionChunk) addChunk(bestInstructionChunk);

  for (const chunk of scored) {
    if (selected.length >= maxChunks) break;
    if (terms.length > 0 && chunk.matched_terms.length === 0 && selected.length > 0) continue;
    addChunk(chunk);
  }

  if (selected.length === 0 && scored[0]) addChunk(scored[0]);

  const selectedPaths = new Set(selected.map((chunk) => chunk.path));
  const selectedFiles = files.filter((file) => selectedPaths.has(file.path));
  const manifestEntry = (file: ContextSourceFile, reason: string): ContextExportManifestEntry => ({
    relative_path: relativePath(root, file.path),
    source_sha256: sourceSha256(file),
    bytes: file.bytes,
    loaded_bytes: Buffer.byteLength(file.content, "utf-8"),
    truncated: file.truncated,
    reason,
  });
  const exportManifest: ContextExportManifest = {
    revision: sourceRevision(root, files),
    included: selectedFiles.map((file) => manifestEntry(file, "selected_within_budget")),
    skipped: files.filter((file) => !selectedPaths.has(file.path)).map((file) => manifestEntry(file, "not_selected_within_budget")),
    truncated: files.filter((file) => file.truncated).map((file) => manifestEntry(file, "max_bytes_per_file")),
    limits: { max_total_bytes: maxTotalBytes, max_chunks: maxChunks },
  };

  return {
    query,
    query_terms: terms,
    files: buildContextMap(root, selectedFiles),
    chunks: selected.map(({ normalized_content, normalized_heading, normalized_path, ...chunk }) => chunk),
    total_bytes: totalBytes,
    omitted_chunks: Math.max(0, scored.length - selected.length),
    omitted_files: Math.max(0, files.length - selectedFiles.length),
    export_manifest: exportManifest,
  };
}