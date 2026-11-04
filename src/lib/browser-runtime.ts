import fs from "node:fs";
import { chromium } from "playwright-core";

/** Shared browser executable discovery used by both visual rendering and the
 * persistent browser tools. Keep platform detection in lib so tool adapters do
 * not depend on each other. */
export function browserCandidates(): string[] {
  const envPath = process.env.CHATGPT_BROWSER_PATH?.trim();
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);

  // playwright-core is protocol-coupled to its downloaded Chromium revision.
  // Prefer that exact binary when it is installed; a newer system Edge/Chrome
  // can accept the process launch but exit before the CDP pipe is established.
  // CHATGPT_BROWSER_PATH remains the explicit operator override.
  try {
    const bundled = chromium.executablePath();
    if (bundled) candidates.push(bundled);
  } catch {}

  if (process.platform === "win32") {
    candidates.push(
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge"
    );
  }
  return [...new Set(candidates)];
}

export function findBrowserExecutable(): string | null {
  for (const candidate of browserCandidates()) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}
