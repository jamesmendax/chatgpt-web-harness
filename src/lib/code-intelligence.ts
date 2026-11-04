import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import { checkpointBefore } from "./checkpoint.js";
import { writeTextFileCas } from "./safe-text-write.js";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", ".cache"]);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export interface CodeFileInventory {
  files: string[];
  truncated: boolean;
  omitted_large_files: string[];
}

export interface CodeLocation {
  file: string;
  line: number;
  character: number;
  length: number;
}

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function collectCodeFiles(root: string, maxFiles = 200): Promise<CodeFileInventory> {
  const files: string[] = [];
  const omittedLarge: string[] = [];
  let truncated = false;

  async function visit(dir: string): Promise<void> {
    if (truncated) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) break;
      if (entry.name.startsWith(".") && entry.isDirectory() && entry.name !== ".config") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        await visit(full);
        continue;
      }
      if (!entry.isFile() || !isCodeFile(full)) continue;
      const stat = await fsp.stat(full);
      if (stat.size > MAX_SOURCE_BYTES) {
        if (omittedLarge.length < 50) omittedLarge.push(full);
        continue;
      }
      files.push(full);
      if (files.length >= maxFiles) truncated = true;
    }
  }

  const stat = await fsp.stat(root);
  if (stat.isFile()) {
    if (!isCodeFile(root)) throw new Error("CODE_INTELLIGENCE_UNSUPPORTED_FILE: expected JS/TS source");
    if (stat.size > MAX_SOURCE_BYTES) throw new Error(`CODE_INTELLIGENCE_FILE_TOO_LARGE: ${stat.size} bytes`);
    return { files: [root], truncated: false, omitted_large_files: [] };
  }
  if (!stat.isDirectory()) throw new Error("CODE_INTELLIGENCE_ROOT_INVALID: expected file or directory");
  await visit(root);
  return { files, truncated, omitted_large_files: omittedLarge };
}

interface ServiceBundle {
  service: ts.LanguageService;
  texts: Map<string, string>;
  cache_hit: boolean;
  backend_fingerprint: string;
  config_file: string | null;
}

interface CachedService {
  service: ts.LanguageService;
  texts: Map<string, string>;
  fingerprint: string;
  configFile: string | null;
}

const SERVICE_CACHE_MAX = 8;
const serviceCache = new Map<string, CachedService>();

function compilerOptionsForRoot(root: string): { options: ts.CompilerOptions; configFile: string | null } {
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    noEmit: true,
    skipLibCheck: true,
    allowSyntheticDefaultImports: true,
  };
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")
    ?? ts.findConfigFile(root, ts.sys.fileExists, "jsconfig.json");
  if (!configPath) return { options: defaults, configFile: null };
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) return { options: defaults, configFile: configPath };
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath));
  return { options: { ...defaults, ...parsed.options, noEmit: true }, configFile: configPath };
}

function serviceKey(root: string, files: readonly string[]): string {
  const normalized = [...files].map((file) => path.resolve(file)).sort();
  return `${path.resolve(root)}\n${normalized.join("\n")}`;
}

function serviceFingerprint(
  texts: Map<string, string>,
  options: ts.CompilerOptions,
  configFile: string | null
): string {
  const hash = createHash("sha256");
  hash.update(`typescript=${ts.version}\n`);
  hash.update(`config=${configFile ?? "<default>"}\n`);
  hash.update(JSON.stringify(options));
  for (const [file, text] of [...texts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(`\nfile=${file}\n`);
    hash.update(createHash("sha256").update(text).digest("hex"));
  }
  return hash.digest("hex");
}

function enforceServiceCacheBound(): void {
  while (serviceCache.size > SERVICE_CACHE_MAX) {
    const oldestKey = serviceCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    serviceCache.get(oldestKey)?.service.dispose();
    serviceCache.delete(oldestKey);
  }
}

function invalidateServiceCache(): void {
  for (const cached of serviceCache.values()) cached.service.dispose();
  serviceCache.clear();
}

function createService(root: string, files: readonly string[]): ServiceBundle {
  const texts = new Map<string, string>();
  for (const file of files) texts.set(path.resolve(file), fs.readFileSync(file, "utf8"));
  const { options, configFile } = compilerOptionsForRoot(root);
  const key = serviceKey(root, files);
  const fingerprint = serviceFingerprint(texts, options, configFile);
  const cached = serviceCache.get(key);
  if (cached?.fingerprint === fingerprint) {
    serviceCache.delete(key);
    serviceCache.set(key, cached);
    return {
      service: cached.service,
      texts: cached.texts,
      cache_hit: true,
      backend_fingerprint: fingerprint,
      config_file: cached.configFile,
    };
  }
  if (cached) {
    cached.service.dispose();
    serviceCache.delete(key);
  }
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...texts.keys()],
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      const resolved = path.resolve(fileName);
      const text = texts.get(resolved) ?? ts.sys.readFile(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };
  const service = ts.createLanguageService(host, ts.createDocumentRegistry());
  serviceCache.set(key, { service, texts, fingerprint, configFile });
  enforceServiceCacheBound();
  return { service, texts, cache_hit: false, backend_fingerprint: fingerprint, config_file: configFile };
}

function backendMetadata(bundle: ServiceBundle) {
  return {
    backend: "typescript-language-service",
    backend_version: ts.version,
    backend_fingerprint: bundle.backend_fingerprint,
    cache_hit: bundle.cache_hit,
    config_file: bundle.config_file,
  };
}

function lineLocation(texts: Map<string, string>, fileName: string, span: ts.TextSpan): CodeLocation {
  const resolved = path.resolve(fileName);
  const text = texts.get(resolved) ?? ts.sys.readFile(fileName) ?? "";
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const lc = source.getLineAndCharacterOfPosition(Math.min(span.start, source.end));
  return { file: resolved, line: lc.line + 1, character: lc.character + 1, length: span.length };
}

function navigationItem(item: ts.NavigateToItem, texts: Map<string, string>) {
  return {
    name: item.name,
    kind: item.kind,
    kind_modifiers: item.kindModifiers,
    match_kind: item.matchKind,
    container_name: item.containerName,
    ...lineLocation(texts, item.fileName, item.textSpan),
  };
}

function implementationItem(item: ts.ImplementationLocation, texts: Map<string, string>) {
  const location = lineLocation(texts, item.fileName, item.textSpan);
  const resolved = path.resolve(item.fileName);
  const text = texts.get(resolved) ?? ts.sys.readFile(item.fileName) ?? "";
  const sourceName = text.slice(item.textSpan.start, item.textSpan.start + item.textSpan.length).trim();
  const display = ts.displayPartsToString(item.displayParts);
  return {
    name: sourceName || display,
    kind: item.kind,
    display,
    ...location,
  };
}

function exactCandidates(service: ts.LanguageService, texts: Map<string, string>, query: string, file?: string, max = 50) {
  const normalizedFile = file ? path.resolve(file) : null;
  const projectFiles = new Set([...texts.keys()].map((item) => path.resolve(item)));
  return service.getNavigateToItems(query, max)
    .filter((item) => projectFiles.has(path.resolve(item.fileName)))
    .filter((item) => item.name === query && (!normalizedFile || path.resolve(item.fileName) === normalizedFile))
    .map((item) => ({ raw: item, view: navigationItem(item, texts) }));
}

export async function codeOutline(filePath: string, maxResults = 200) {
  const inventory = await collectCodeFiles(filePath, 1);
  const file = inventory.files[0];
  const bundle = createService(path.dirname(file), [file]);
  const { service, texts } = bundle;
  const tree = service.getNavigationTree(file);
  const results: Array<Record<string, unknown>> = [];
  const walk = (item: ts.NavigationTree, depth: number) => {
    for (const span of item.spans) {
      if (item.text !== "<global>" && results.length < maxResults) {
        results.push({ name: item.text, kind: item.kind, kind_modifiers: item.kindModifiers, depth, ...lineLocation(texts, file, span) });
      }
    }
    for (const child of item.childItems ?? []) {
      if (results.length >= maxResults) break;
      walk(child, depth + 1);
    }
  };
  walk(tree, 0);
  return { ...backendMetadata(bundle), file, symbols: results, truncated: results.length >= maxResults };
}

export async function codeFind(root: string, query: string, maxFiles = 200, maxResults = 100) {
  const inventory = await collectCodeFiles(root, maxFiles);
  const bundle = createService(root, inventory.files);
  const { service, texts } = bundle;
  const projectFiles = new Set(inventory.files.map((item) => path.resolve(item)));
  const items = service.getNavigateToItems(query, Math.min(maxResults * 4, 2000))
    .filter((item) => projectFiles.has(path.resolve(item.fileName)))
    .slice(0, maxResults)
    .map((item) => navigationItem(item, texts));
  return { ...backendMetadata(bundle), query, items, files_indexed: inventory.files.length, inventory_truncated: inventory.truncated, omitted_large_files: inventory.omitted_large_files };
}

export async function codeReferences(root: string, query: string, file: string | undefined, maxFiles = 200, maxResults = 200) {
  const inventory = await collectCodeFiles(root, maxFiles);
  const bundle = createService(root, inventory.files);
  const { service, texts } = bundle;
  const candidates = exactCandidates(service, texts, query, file, 100);
  if (candidates.length !== 1) {
    return { ...backendMetadata(bundle), query, ambiguous: candidates.length > 1, candidates: candidates.map((item) => item.view), references: [], files_indexed: inventory.files.length, inventory_truncated: inventory.truncated };
  }
  const candidate = candidates[0].raw;
  const groups = service.findReferences(candidate.fileName, candidate.textSpan.start) ?? [];
  const references = groups.flatMap((group) => group.references.map((ref) => ({
    ...lineLocation(texts, ref.fileName, ref.textSpan),
    is_definition: ref.isDefinition,
    is_write_access: ref.isWriteAccess,
  }))).slice(0, maxResults);
  return { ...backendMetadata(bundle), query, ambiguous: false, symbol: candidates[0].view, references, truncated: references.length >= maxResults, files_indexed: inventory.files.length, inventory_truncated: inventory.truncated };
}

export async function codeDefinition(root: string, query: string, file: string | undefined, maxFiles = 200, maxResults = 50) {
  const inventory = await collectCodeFiles(root, maxFiles);
  const bundle = createService(root, inventory.files);
  const { service, texts } = bundle;
  const candidates = exactCandidates(service, texts, query, file, 100);
  if (candidates.length !== 1) {
    return { ...backendMetadata(bundle), query, ambiguous: candidates.length > 1, candidates: candidates.map((item) => item.view), definitions: [], files_indexed: inventory.files.length, inventory_truncated: inventory.truncated };
  }
  const candidate = candidates[0].raw;
  const definitions = (service.getDefinitionAtPosition(candidate.fileName, candidate.textSpan.start) ?? [])
    .slice(0, maxResults)
    .map((definition) => ({ name: definition.name, kind: definition.kind, container_name: definition.containerName, ...lineLocation(texts, definition.fileName, definition.textSpan) }));
  return { ...backendMetadata(bundle), query, ambiguous: false, symbol: candidates[0].view, definitions, files_indexed: inventory.files.length, inventory_truncated: inventory.truncated };
}

export async function codeImplementations(root: string, query: string, file: string | undefined, maxFiles = 200, maxResults = 100) {
  const inventory = await collectCodeFiles(root, maxFiles);
  const bundle = createService(root, inventory.files);
  const { service, texts } = bundle;
  const candidates = exactCandidates(service, texts, query, file, 100);
  if (candidates.length !== 1) {
    return {
      ...backendMetadata(bundle),
      query,
      ambiguous: candidates.length > 1,
      candidates: candidates.map((item) => item.view),
      implementations: [],
      files_indexed: inventory.files.length,
      inventory_truncated: inventory.truncated,
    };
  }

  const candidate = candidates[0].raw;
  const implementations = (service.getImplementationAtPosition(candidate.fileName, candidate.textSpan.start) ?? [])
    .slice(0, maxResults)
    .map((implementation) => implementationItem(implementation, texts));
  return {
    ...backendMetadata(bundle),
    query,
    ambiguous: false,
    symbol: candidates[0].view,
    implementations,
    truncated: implementations.length >= maxResults,
    files_indexed: inventory.files.length,
    inventory_truncated: inventory.truncated,
  };
}

export async function codeDiagnostics(filePath: string, maxResults = 100) {
  const inventory = await collectCodeFiles(filePath, 1);
  const file = inventory.files[0];
  const bundle = createService(path.dirname(file), [file]);
  const { service, texts } = bundle;
  const diagnostics = [...service.getSyntacticDiagnostics(file), ...service.getSemanticDiagnostics(file)]
    .slice(0, maxResults)
    .map((diag) => ({
      code: diag.code,
      category: ts.DiagnosticCategory[diag.category],
      message: ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
      ...(diag.start === undefined ? {} : lineLocation(texts, file, { start: diag.start, length: diag.length ?? 0 })),
    }));
  return { ...backendMetadata(bundle), file, diagnostics, truncated: diagnostics.length >= maxResults };
}

export async function codeRenameLocations(root: string, query: string, file: string | undefined, maxFiles = 200, maxResults = 200) {
  const inventory = await collectCodeFiles(root, maxFiles);
  const bundle = createService(root, inventory.files);
  const { service, texts } = bundle;
  const candidates = exactCandidates(service, texts, query, file, 100);
  if (candidates.length !== 1) {
    return { ...backendMetadata(bundle), query, ambiguous: candidates.length > 1, candidates: candidates.map((item) => item.view), locations: [], files_indexed: inventory.files.length, inventory_truncated: inventory.truncated };
  }
  const candidate = candidates[0].raw;
  const locations = (service.findRenameLocations(candidate.fileName, candidate.textSpan.start, false, false, true) ?? [])
    .slice(0, maxResults)
    .map((location) => ({ ...lineLocation(texts, location.fileName, location.textSpan), prefix_text: location.prefixText, suffix_text: location.suffixText }));
  return { ...backendMetadata(bundle), query, ambiguous: false, symbol: candidates[0].view, locations, truncated: locations.length >= maxResults, files_indexed: inventory.files.length, inventory_truncated: inventory.truncated };
}

function textSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function applyRenameLocations(original: string, locations: readonly ts.RenameLocation[], newName: string): string {
  const deduplicated = new Map<string, ts.RenameLocation>();
  for (const location of locations) {
    const key = `${location.textSpan.start}:${location.textSpan.length}:${location.prefixText ?? ""}:${location.suffixText ?? ""}`;
    deduplicated.set(key, location);
  }
  const edits = [...deduplicated.values()].sort((left, right) => right.textSpan.start - left.textSpan.start);
  let updated = original;
  let previousStart = original.length + 1;
  for (const location of edits) {
    const start = location.textSpan.start;
    const end = start + location.textSpan.length;
    if (start < 0 || end > original.length || end > previousStart) {
      throw new Error("CODE_RENAME_INVALID_EDIT_SET: overlapping or out-of-range semantic edits");
    }
    updated = `${updated.slice(0, start)}${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}${updated.slice(end)}`;
    previousStart = start;
  }
  return updated;
}

export async function codeRenameApply(
  root: string,
  query: string,
  newName: string,
  file: string | undefined,
  maxFiles = 200,
  maxResults = 200
) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) {
    throw new Error("CODE_RENAME_INVALID_NAME: new_name must be a JavaScript/TypeScript identifier");
  }

  const inventory = await collectCodeFiles(root, maxFiles);
  if (inventory.truncated) {
    return {
      backend: "typescript-language-service",
      query,
      new_name: newName,
      applied: false,
      reason: "inventory_truncated",
      files_indexed: inventory.files.length,
      inventory_truncated: true,
    };
  }

  const bundle = createService(root, inventory.files);
  const { service, texts } = bundle;
  const candidates = exactCandidates(service, texts, query, file, 100);
  if (candidates.length !== 1) {
    return {
      ...backendMetadata(bundle),
      query,
      new_name: newName,
      applied: false,
      ambiguous: candidates.length > 1,
      candidates: candidates.map((item) => item.view),
      files_indexed: inventory.files.length,
      inventory_truncated: false,
    };
  }

  const candidate = candidates[0].raw;
  const renameInfo = service.getRenameInfo(candidate.fileName, candidate.textSpan.start, { allowRenameOfImportPath: false });
  if (!renameInfo.canRename) {
    return {
      ...backendMetadata(bundle),
      query,
      new_name: newName,
      applied: false,
      reason: "rename_not_allowed",
      detail: renameInfo.localizedErrorMessage,
    };
  }

  const rawLocations = service.findRenameLocations(candidate.fileName, candidate.textSpan.start, false, false, true) ?? [];
  if (rawLocations.length === 0) {
    return { ...backendMetadata(bundle), query, new_name: newName, applied: false, reason: "no_rename_locations" };
  }
  if (rawLocations.length > maxResults) {
    return {
      ...backendMetadata(bundle),
      query,
      new_name: newName,
      applied: false,
      reason: "rename_locations_exceed_limit",
      location_count: rawLocations.length,
      max_results: maxResults,
    };
  }

  const projectFiles = new Set(inventory.files.map((item) => path.resolve(item)));
  const externalFiles = [...new Set(rawLocations
    .map((location) => path.resolve(location.fileName))
    .filter((locationFile) => !projectFiles.has(locationFile)))];
  if (externalFiles.length > 0) {
    return {
      ...backendMetadata(bundle),
      query,
      new_name: newName,
      applied: false,
      reason: "rename_has_external_locations",
      external_files: externalFiles.slice(0, 50),
    };
  }

  const locationsByFile = new Map<string, ts.RenameLocation[]>();
  for (const location of rawLocations) {
    const resolved = path.resolve(location.fileName);
    const list = locationsByFile.get(resolved) ?? [];
    list.push(location);
    locationsByFile.set(resolved, list);
  }

  const plans = [...locationsByFile.entries()].map(([target, locations]) => {
    const original = texts.get(target) ?? fs.readFileSync(target, "utf8");
    const updated = applyRenameLocations(original, locations, newName);
    return {
      file: target,
      original,
      updated,
      expectedSha256: textSha256(original),
      editCount: locations.length,
    };
  }).filter((plan) => plan.original !== plan.updated);

  for (const plan of plans) {
    const current = fs.readFileSync(plan.file, "utf8");
    if (textSha256(current) !== plan.expectedSha256) {
      return {
        ...backendMetadata(bundle),
        query,
        new_name: newName,
        applied: false,
        reason: "source_changed_before_apply",
        conflict_file: plan.file,
      };
    }
  }

  const checkpointId = await checkpointBefore(
    "code_intelligence.rename_apply",
    plans.map((plan) => plan.file),
    { summary: `semantic rename ${query} -> ${newName}` }
  );
  const written: Array<{ file: string; original: string; writtenSha256: string }> = [];
  try {
    for (const plan of plans) {
      const result = await writeTextFileCas(plan.file, plan.updated, { expectedSha256: plan.expectedSha256 });
      written.push({ file: plan.file, original: plan.original, writtenSha256: result.sha256 });
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const item of [...written].reverse()) {
      try {
        await writeTextFileCas(item.file, item.original, { expectedSha256: item.writtenSha256 });
      } catch {
        rollbackFailures.push(item.file);
      }
    }
    invalidateServiceCache();
    if (rollbackFailures.length > 0) {
      throw new Error(`CODE_RENAME_PARTIAL_FAILURE: rollback failed for ${rollbackFailures.join(", ")}; original_error=${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  }

  invalidateServiceCache();
  return {
    ...backendMetadata(bundle),
    query,
    new_name: newName,
    applied: true,
    checkpoint_id: checkpointId,
    changed_files: plans.map((plan) => ({ file: plan.file, edits: plan.editCount })),
    edit_count: plans.reduce((sum, plan) => sum + plan.editCount, 0),
    file_count: plans.length,
  };
}
