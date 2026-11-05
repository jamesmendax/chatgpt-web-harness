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
  const localInput = !windowsPath && /^file:/i.test(input) ? fileURLToPath(input) : input;
  const localPath = await validatePath(localInput);
  const stat = await fs.stat(localPath);
  if (!stat.isFile()) throw new Error("Local browser target must be a file");
  return { target: pathToFileURL(localPath).toString(), label: localPath };
}
