import fs from "node:fs";
import { chromium, type Browser } from "playwright-core";
import { verifiedOfflineBrowserPath } from "./browser-use-provider.js";

export function browserCandidates(): string[] {
  const explicit = process.env.CHATGPT_BROWSER_PATH?.trim();
  if (explicit) return [explicit];
  const candidates: string[] = [];
  if (process.env.HARNESS_BROWSER_USE_RUNTIME_ROOT && process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK) {
    try { candidates.push(verifiedOfflineBrowserPath()); } catch { /* invalid runtime falls back to system browsers */ }
  }
  if (process.platform === "win32") candidates.push(
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
  else if (process.platform === "darwin") candidates.push(
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  else candidates.push("/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  try { candidates.push(chromium.executablePath()); } catch {}
  return [...new Set(candidates.filter(Boolean))];
}
function isFile(candidate: string): boolean { try { return fs.statSync(candidate).isFile(); } catch { return false; } }
export function findBrowserExecutable(): string | null {
  const explicit = process.env.CHATGPT_BROWSER_PATH?.trim();
  if (explicit && !isFile(explicit)) throw new Error(`Explicit browser path is invalid: ${explicit}`);
  return browserCandidates().find(isFile) ?? null;
}
export async function launchBrowser(timeoutMs = 30000): Promise<{ browser: Browser; executablePath: string }> {
  const explicit = process.env.CHATGPT_BROWSER_PATH?.trim();
  if (explicit && !isFile(explicit)) throw new Error(`Explicit browser path is invalid: ${explicit}`);
  const errors: string[] = [];
  const deadline = Date.now() + timeoutMs;
  for (const executablePath of browserCandidates()) {
    if (!isFile(executablePath)) continue;
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("browser launch deadline exceeded");
      const browser = await chromium.launch({ executablePath, headless: true, timeout: remaining,
        args: ["--disable-gpu", "--no-first-run", "--disable-extensions"] });
      return { browser, executablePath };
    } catch (error) { errors.push(`${executablePath}: ${String(error)}`); if (explicit) break; }
  }
  throw new Error(`Browser launch failed: ${errors.join("; ") || "no supported browser found"}`);
}
