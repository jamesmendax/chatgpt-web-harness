import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBrowserUseEnabled, isComputerUseEnabled } from "./plugin-config.js";
import { readComputerUseCapability } from "./computer-use-provider.js";

interface ProviderManifest {
  id?: string;
  version?: string;
  provider?: string;
  protocol_version?: number;
}

export interface ProviderHealth {
  id: string;
  version: string | null;
  provider: string | null;
  protocol_version: number | null;
  available: boolean;
  enabled: boolean;
  ready: boolean;
  reason?: string;
  status: "unsupported" | "missing" | "disabled" | "ready" | "misconfigured";
  health_check: { tool: string; input: Record<string, unknown> };
}

const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function nonEmptyFile(file: string | undefined): boolean {
  if (!file) return false;
  try { return fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch { return false; }
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function manifest(codeRoot: string, id: "computer-use" | "browser-use"): ProviderManifest | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(codeRoot, "bundled-plugins", id, "manifest.json"), "utf8")) as ProviderManifest;
  } catch { return null; }
}

function base(id: "computer-use" | "browser-use", value: ProviderManifest | null) {
  return {
    id,
    version: typeof value?.version === "string" ? value.version : null,
    provider: typeof value?.provider === "string" ? value.provider : null,
    protocol_version: Number.isSafeInteger(value?.protocol_version) ? value!.protocol_version! : null,
  };
}

function state(available: boolean, enabled: boolean, ready: boolean): ProviderHealth["status"] {
  if (process.platform !== "win32") return "unsupported";
  if (!available) return "missing";
  if (!enabled) return "disabled";
  return ready ? "ready" : "misconfigured";
}

function computerUseHealth(codeRoot: string): ProviderHealth {
  const value = manifest(codeRoot, "computer-use");
  const helper = path.join(codeRoot, "bundled-plugins", "computer-use", "windows-action.ps1");
  const available = process.platform === "win32" && Boolean(value) && nonEmptyFile(helper);
  const enabled = isComputerUseEnabled();
  const expectedHelper = process.env.HARNESS_COMPUTER_USE_HELPER;
  const expectedHash = process.env.HARNESS_COMPUTER_USE_HELPER_SHA256?.trim().toLowerCase();
  let integrity = false;
  try {
    integrity = Boolean(expectedHelper && path.resolve(expectedHelper) === path.resolve(helper) &&
      /^[a-f0-9]{64}$/.test(expectedHash || "") && sha256(helper) === expectedHash);
  } catch {}
  let configured = false;
  let reason: string | undefined;
  if (available && enabled) {
    try { readComputerUseCapability(); configured = true; }
    catch (error) { reason = error instanceof Error ? error.message : String(error); }
  }
  const ready = available && enabled && configured && integrity;
  return {
    ...base("computer-use", value), available, enabled, ready,
    status: state(available, enabled, ready),
    ...(reason ? { reason } : {}),
    health_check: { tool: "computer_use", input: { action: "status" } },
  };
}

function verifiedBrowserCache(codeRoot: string, runtimeRoot: string | undefined): boolean {
  if (!runtimeRoot) return false;
  try {
    const raw = fs.readFileSync(path.join(codeRoot, "vendor", "browser-use.archive.json"), "utf8");
    const metadata = JSON.parse(raw) as { sha256?: string };
    if (!/^[a-f0-9]{64}$/.test(metadata.sha256 || "") || path.basename(path.resolve(runtimeRoot)) !== metadata.sha256!.slice(0, 20)) return false;
    const marker = JSON.parse(fs.readFileSync(path.join(runtimeRoot, ".runtime-complete.json"), "utf8")) as { sha256?: string; metadataHash?: string };
    return marker.sha256 === metadata.sha256 && marker.metadataHash === createHash("sha256").update(raw).digest("hex") && [
      "python/python.exe", "chrome/chrome-win64/chrome.exe", "provenance.json", "SBOM.spdx.json",
      "site-packages/browser_use/__init__.py", "site-packages/browser_harness/__init__.py",
    ].every(file => nonEmptyFile(path.join(runtimeRoot, file)));
  } catch { return false; }
}

/** The deferred runtime ships as one archive that is prepared on first use; available means it is packaged intact. */
function packagedBrowserArchive(codeRoot: string): boolean {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(codeRoot, "vendor", "browser-use.archive.json"), "utf8")) as { archive?: unknown; sha256?: unknown; bytes?: unknown };
    if (typeof metadata.archive !== "string" || path.basename(metadata.archive) !== metadata.archive) return false;
    if (typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.bytes)) return false;
    const stat = fs.statSync(path.join(codeRoot, "vendor", metadata.archive));
    return stat.isFile() && stat.size === metadata.bytes;
  } catch { return false; }
}

function browserUseHealth(codeRoot: string): ProviderHealth {
  const value = manifest(codeRoot, "browser-use");
  const runtimeRoot = process.env.HARNESS_BROWSER_USE_RUNTIME_ROOT;
  const lock = process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK;
  const expectedLockHash = process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256?.trim().toLowerCase();
  const bundledRuntime = path.join(codeRoot, "vendor", "browser-use");
  const bundledLock = path.join(codeRoot, "bundled-plugins", "browser-use", "runtime-lock.json");
  const cached = verifiedBrowserCache(codeRoot, runtimeRoot);
  const legacyAvailable = [
    path.join(bundledRuntime, "python", "python.exe"),
    path.join(bundledRuntime, "chrome", "chrome-win64", "chrome.exe"),
    path.join(bundledRuntime, "provenance.json"),
    path.join(bundledRuntime, "SBOM.spdx.json"),
    bundledLock,
  ].every(nonEmptyFile);
  const available = process.platform === "win32" && Boolean(value) && nonEmptyFile(bundledLock) &&
    (legacyAvailable || cached || packagedBrowserArchive(codeRoot));
  const enabled = isBrowserUseEnabled();
  let integrity = false;
  try {
    integrity = Boolean(runtimeRoot && lock &&
      (path.resolve(runtimeRoot) === path.resolve(bundledRuntime) || cached) &&
      path.resolve(lock) === path.resolve(bundledLock) &&
      /^[a-f0-9]{64}$/.test(expectedLockHash || "") && sha256(bundledLock) === expectedLockHash);
  } catch {}
  const configured = nonEmptyFile(process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK) &&
    typeof process.env.HARNESS_BROWSER_USE_DATA_DIR === "string" &&
    process.env.HARNESS_BROWSER_USE_DATA_DIR.length > 0;
  const ready = available && enabled && configured && integrity;
  return {
    ...base("browser-use", value), available, enabled, ready,
    status: state(available, enabled, ready),
    health_check: { tool: "browser_use_screenshot", input: { full: false, max_dim: 1200 } },
  };
}

export function getProviderHealth(codeRoot = CODE_ROOT): Record<"computer_use" | "browser_use", ProviderHealth> {
  return { computer_use: computerUseHealth(codeRoot), browser_use: browserUseHealth(codeRoot) };
}
