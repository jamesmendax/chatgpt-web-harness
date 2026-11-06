import { fileURLToPath, pathToFileURL } from "node:url";
import { physicalPromises as fs } from "./physical-fs.js";
import { validatePath } from "./path-security.js";

export async function resolveBrowserTarget(raw: string): Promise<{ target: string; label: string }> {
  const input = raw.trim();
  const windowsPath = /^[a-z]:[\\/]/i.test(input) || /^\\\\/.test(input);
  if (!windowsPath && /^https?:\/\//i.test(input)) {
    const target = new URL(input).toString();
    return { target, label: target };
  }
  // Non-file schemes and bare dev servers are URLs, not file names (they used
  // to fail with ENOENT): data:, about:, blob:, and host:port such as localhost:3000.
  if (!windowsPath && /^(?:data|about|blob|view-source):/i.test(input)) return { target: input, label: input.slice(0, 120) };
  // Only loopback hosts: "index.html" or "notes.md" must stay local files.
  if (!windowsPath && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(input)) {
    const target = new URL("http://" + input).toString();
    return { target, label: target };
  }
  // Keep a file URL's ?query and #fragment (single-page apps route on them).
  let suffix = "";
  let localInput = input;
  if (!windowsPath && /^file:/i.test(input)) {
    const url = new URL(input);
    suffix = url.search + url.hash;
    url.search = ""; url.hash = "";
    localInput = fileURLToPath(url);
  }
  const localPath = await validatePath(localInput);
  const stat = await fs.stat(localPath);
  if (!stat.isFile()) throw new Error("Local browser target must be a file");
  return { target: pathToFileURL(localPath).toString() + suffix, label: localPath };
}
