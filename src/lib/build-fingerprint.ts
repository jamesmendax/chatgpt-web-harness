import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function runtimeContent(root: string) {
  const files: Array<{ path: string; sha256: string }> = [];
  function visit(relative: string): void {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Runtime fingerprint refuses linked paths: ${name}`);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && (relative !== "dist" && !name.startsWith("dist/") || name.endsWith(".js"))) {
        files.push({ path: name, sha256: createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex") });
      }
    }
  }
  visit("dist");
  visit("bundled-plugins");
  for (const name of ["service-recovery-host.mjs", "service-recovery-worker.mjs", "service-recovery-guardian.mjs"]) {
    const relative = `scripts/${name}`;
    if (fs.existsSync(path.join(root, relative))) files.push({ path: relative, sha256: createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex") });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version as string;
  return { schema_version: 1, version, content_sha256: createHash("sha256").update(JSON.stringify({ version, files })).digest("hex"), files };
}
