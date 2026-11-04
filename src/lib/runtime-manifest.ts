import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_TOOL_CATALOG,
  getChatGptToolProfile,
  shouldExposeTool,
  type ToolProfileName,
} from "./tool-profile.js";
import { runtimeContent } from "./build-fingerprint.js";

const RUNTIME_MODULE_PATH = fileURLToPath(import.meta.url);
const STARTED_AT = new Date().toISOString();
const LOADED_RUNTIME_MTIME_MS = fs.statSync(RUNTIME_MODULE_PATH).mtimeMs;
const ROOT = path.resolve(path.dirname(RUNTIME_MODULE_PATH), "..", "..");
const MANIFEST_PATH = path.join(ROOT, "dist", "build-manifest.json");
const PACKAGE_VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
export const APP_VERSION = process.env.HARNESS_APP_VERSION || PACKAGE_VERSION;
function readBuild(): { version: string; content_sha256: string } | null {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")); } catch { return null; }
}
const BUILD = readBuild();
let verification = { at: 0, stale: true };
let catalog: WeakRef<{ list(): Array<{ name: string }> }> | undefined;
export function setRuntimeToolCatalog(value: { list(): Array<{ name: string }> }): void {
  catalog = new WeakRef(value);
}
const PROFILE = getChatGptToolProfile();
const BUILD_ID = (BUILD?.content_sha256 || digest("unrecorded-build")).slice(0, 16);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function localToolNames(profile: ToolProfileName): string[] {
  return LOCAL_TOOL_CATALOG
    .filter((name) => shouldExposeTool(name, profile))
    .sort((left, right) => left.localeCompare(right));
}

function currentRuntimeMtimeMs(): number {
  try {
    return fs.statSync(RUNTIME_MODULE_PATH).mtimeMs;
  } catch {
    return 0;
  }
}

export interface RuntimeManifest {
  pid: number;
  started_at: string;
  build_id: string;
  tool_profile: ToolProfileName;
  tool_count: number;
  tool_names: string[];
  tool_manifest_hash: string;
  loaded_runtime_mtime_ms: number;
  current_runtime_mtime_ms: number;
  stale_build: boolean;
  app_version: string;
  build_version: string;
  content_sha256: string | null;
  fingerprint_status: "verified" | "changed" | "missing";
  fingerprint_checked_at: string;
  catalog_source: "registered" | "configured";
}

export function getRuntimeManifest(verifyFiles = false): RuntimeManifest {
  const currentMtime = currentRuntimeMtimeMs();
  if (verifyFiles || Date.now() - verification.at >= 5_000) {
    let stale = true;
    try { stale = !BUILD || readBuild()?.content_sha256 !== BUILD.content_sha256 || runtimeContent(ROOT).content_sha256 !== BUILD.content_sha256; } catch {}
    verification = { at: Date.now(), stale };
  }
  const registered = catalog?.deref();
  const names = registered ? registered.list().map(tool => tool.name).sort() : localToolNames(PROFILE);
  return {
    pid: process.pid,
    started_at: STARTED_AT,
    build_id: BUILD_ID,
    tool_profile: PROFILE,
    tool_count: names.length,
    tool_names: names,
    tool_manifest_hash: digest(names.join("\n")),
    loaded_runtime_mtime_ms: LOADED_RUNTIME_MTIME_MS,
    current_runtime_mtime_ms: currentMtime,
    stale_build: verification.stale,
    app_version: APP_VERSION,
    build_version: BUILD?.version ?? PACKAGE_VERSION,
    content_sha256: BUILD?.content_sha256 ?? null,
    fingerprint_status: !BUILD ? "missing" : verification.stale ? "changed" : "verified",
    fingerprint_checked_at: new Date(verification.at).toISOString(),
    catalog_source: registered ? "registered" : "configured",
  };
}

export function getRuntimeManifestSummary(): Omit<RuntimeManifest, "tool_names"> {
  const { tool_names: _toolNames, ...summary } = getRuntimeManifest();
  return summary;
}
