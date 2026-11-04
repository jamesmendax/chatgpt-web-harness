import fs from "node:fs";
import path from "node:path";

const PERSONAL_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/;
const NARROW_PERSONAL_PATH = /[A-Za-z]:[\\/](?:chatgpt-local-coder|Crack|Coding)(?:[\\/]|$)/i;
const REQUIRED_PROFILES = new Set([
  "chatgpt-connector-description.txt",
  "mcp-upstream.json",
  "plugins.json",
  "post-edit-hooks.json",
]);
const BINARY_EXTENSIONS = new Set([".exe", ".png", ".ico", ".zip", ".7z", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2"]);

function filesUnder(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`staging 路径必须是普通目录: ${root}`);
  const rootReal = path.resolve(fs.realpathSync(root));
  const inside = (candidate) => {
    const relative = path.relative(rootReal, path.resolve(candidate));
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  const visit = (dir) => {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(`staging 含不支持的符号链接或文件类型: ${path.relative(root, dir)}`);
    const dirReal = path.resolve(fs.realpathSync(dir));
    if (!inside(dirReal)) throw new Error(`staging 真实路径逃逸: ${path.relative(root, dir)}`);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`staging 含不支持的符号链接或 junction: ${path.relative(root, full)}`);
      const real = path.resolve(fs.realpathSync(full));
      if (!inside(real)) throw new Error(`staging 真实路径逃逸: ${path.relative(root, full)}`);
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) out.push(full);
      else throw new Error(`staging 含不支持的文件类型: ${path.relative(root, full)}`);
    }
  };
  visit(root);
  return out;
}

function readTextIfSafe(file) {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
  const stat = fs.statSync(file);
  if (stat.size > 8 * 1024 * 1024) return null;
  return fs.readFileSync(file, "utf8");
}

export function assertStagingSafe(stagingRoot) {
  const profiles = path.join(stagingRoot, "profiles");
  const names = fs.existsSync(profiles)
    ? fs.readdirSync(profiles, { withFileTypes: true }).map((entry) => entry.name)
    : [];
  if (names.includes("local-skills")) throw new Error("发布 profiles 不得包含 local-skills");
  const actual = new Set(names);
  if (actual.size !== REQUIRED_PROFILES.size || [...REQUIRED_PROFILES].some((name) => !actual.has(name))) {
    throw new Error(`发布 profiles 文件集不安全: ${names.join(", ")}`);
  }

  for (const file of filesUnder(profiles)) {
    const text = readTextIfSafe(file);
    if (text !== null && PERSONAL_PATH.test(text)) {
      throw new Error(`profiles 含绝对盘符路径: ${path.relative(stagingRoot, file)}`);
    }
  }

  for (const file of filesUnder(stagingRoot)) {
    const text = readTextIfSafe(file);
    if (text !== null && NARROW_PERSONAL_PATH.test(text)) {
      throw new Error(`staging 含开发机路径: ${path.relative(stagingRoot, file)}`);
    }
  }
  return true;
}

export { PERSONAL_PATH, NARROW_PERSONAL_PATH };
