import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const vendorRoot = path.join(repoRoot, "vendor");
const target = path.join(vendorRoot, "browser-use");
const cache = path.join(repoRoot, ".release-tools", "cache", "browser-use-runtime");
const wheelhouse = path.join(cache, "wheels-cp312-win-amd64");
const lockPath = path.join(repoRoot, "bundled-plugins", "browser-use", "runtime-lock.json");
const driveRoot = path.parse(repoRoot).root;
const work = path.join(driveRoot, `.harness-browser-runtime-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
const build = path.join(work, "browser-use");

const PYTHON_VERSION = "3.12.10";
const PYTHON_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const CHROME_VERSION = "153.0.8010.36";
const CHROME_URL = `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/win64/chrome-win64.zip`;
const BROWSER_USE_VERSION = "0.13.10";
const BROWSER_USE_COMMIT = "5c892e013a73e6622e6f50336e1eb0aa2c4405f2";
const BROWSER_HARNESS_VERSION = "0.1.13";
const BROWSER_HARNESS_COMMIT = "c24e5072ee66f8499bacd663f4f4bcb089bc4492";

function inside(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function assertSafeLayout() {
  if (!inside(repoRoot, target) || !inside(repoRoot, cache) || !inside(repoRoot, lockPath)) throw new Error("Browser runtime output escaped repository root");
  if (path.dirname(work) !== driveRoot || !path.basename(work).startsWith(".harness-browser-runtime-")) throw new Error("Unsafe Browser runtime work directory");
}

function run(command, args, options = {}) {
  console.log(`[browser-runtime] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || process.env,
    windowsHide: true,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.error?.message || result.stderr || "unknown error"}`);
  }
  return options.capture ? String(result.stdout || "").trim() : "";
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function download(url, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    run("curl.exe", ["--fail", "--location", "--retry", "4", "--retry-delay", "2", "--output", file, url]);
  }
  return { url, file, bytes: fs.statSync(file).size, sha256: sha256(file) };
}

function extract(zip, destination) {
  fs.mkdirSync(destination, { recursive: true });
  run("tar.exe", ["-xf", zip, "-C", destination]);
}

function walk(dir) {
  const out = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in Browser runtime: ${full}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  visit(dir);
  return out;
}

function metadataValue(text, key) {
  const prefix = `${key}:`;
  return text.split(/\r?\n/).find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || "";
}

function installedPackages(sitePackages) {
  return fs.readdirSync(sitePackages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".dist-info"))
    .map((entry) => {
      const dir = path.join(sitePackages, entry.name);
      const metadata = fs.readFileSync(path.join(dir, "METADATA"), "utf8");
      const name = metadataValue(metadata, "Name") || entry.name.replace(/\.dist-info$/i, "");
      const version = metadataValue(metadata, "Version") || "NOASSERTION";
      const licenseExpression = metadataValue(metadata, "License-Expression") || metadataValue(metadata, "License") || "NOASSERTION";
      return { name, version, licenseExpression, dir };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function copyLicenses(packages, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const pkg of packages) {
    const packageDir = path.join(destination, pkg.name.replace(/[^a-z0-9._-]/gi, "_"));
    const candidates = walk(pkg.dir).filter((file) => /(?:^|[\\/])licenses?[\\/]|(?:^|[\\/])(?:license|copying|notice)(?:[._-]|$)/i.test(file));
    if (!candidates.length) {
      fs.mkdirSync(packageDir, { recursive: true });
      fs.writeFileSync(path.join(packageDir, "METADATA-LICENSE.txt"), `${pkg.name} ${pkg.version}\nDeclared license: ${pkg.licenseExpression}\n`, "utf8");
      continue;
    }
    for (const file of candidates) {
      const rel = path.relative(pkg.dir, file);
      const to = path.join(packageDir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(file, to);
    }
  }
}

function makeSpdx(packages, artifacts) {
  const created = new Date().toISOString();
  const normalized = (value) => value.replace(/[^A-Za-z0-9.-]/g, "-");
  const spdxPackages = packages.map((pkg) => ({
    SPDXID: `SPDXRef-Package-${normalized(pkg.name)}-${normalized(pkg.version)}`,
    name: pkg.name,
    versionInfo: pkg.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: /^[A-Za-z0-9.+-]+$/.test(pkg.licenseExpression) ? pkg.licenseExpression : "NOASSERTION",
    copyrightText: "NOASSERTION",
  }));
  for (const artifact of artifacts) {
    spdxPackages.push({
      SPDXID: `SPDXRef-Artifact-${normalized(artifact.name)}`,
      name: artifact.name,
      versionInfo: artifact.version,
      downloadLocation: artifact.url,
      filesAnalyzed: false,
      checksums: [{ algorithm: "SHA256", checksumValue: artifact.sha256 }],
      licenseConcluded: "NOASSERTION",
      licenseDeclared: artifact.license,
      copyrightText: "NOASSERTION",
    });
  }
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `chatgpt-web-harness-browser-use-${BROWSER_USE_VERSION}`,
    documentNamespace: `https://chatgpt-web-harness.invalid/spdx/browser-use/${crypto.randomUUID()}`,
    creationInfo: { created, creators: ["Tool: ChatGPT-Web-Harness-runtime-builder-1.0.0"] },
    packages: spdxPackages,
    relationships: spdxPackages.map((pkg) => ({ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: pkg.SPDXID })),
  };
}

function readExistingLock() {
  try { return JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { return null; }
}

function enforceExistingLock(existing, next) {
  if (!existing) return;
  for (const key of ["python", "chrome_for_testing"]) {
    if (existing[key]?.url !== next[key].url || existing[key]?.sha256 !== next[key].sha256) {
      throw new Error(`${key} artifact differs from the checked runtime lock`);
    }
  }
  const expected = new Map((existing.wheels || []).map((item) => [item.file, item.sha256]));
  const actual = new Map((next.wheels || []).map((item) => [item.file, item.sha256]));
  if (expected.size !== actual.size || [...expected].some(([file, hash]) => actual.get(file) !== hash)) {
    throw new Error("Python wheel set differs from the checked runtime lock");
  }
}

function existingRuntimeVerified() {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const provenance = JSON.parse(fs.readFileSync(path.join(target, "provenance.json"), "utf8"));
    if (lock.schema_version !== 1 || provenance.schema_version !== 1) return false;
    if (lock.browser_use?.version !== BROWSER_USE_VERSION || lock.browser_use?.commit !== BROWSER_USE_COMMIT) return false;
    if (lock.browser_harness?.version !== BROWSER_HARNESS_VERSION || lock.browser_harness?.commit !== BROWSER_HARNESS_COMMIT) return false;
    if (lock.python?.version !== PYTHON_VERSION || lock.chrome_for_testing?.version !== CHROME_VERSION) return false;
    if (provenance.telemetry_default !== "disabled") return false;
    for (const key of ["browser_use", "browser_harness", "python", "chrome_for_testing", "wheels"]) {
      if (JSON.stringify(provenance[key]) !== JSON.stringify(lock[key])) return false;
    }
    const requiredCritical = [
      "python/python.exe", "python/python312.dll", "chrome/chrome-win64/chrome.exe",
      "site-packages/browser_use/__init__.py", "site-packages/browser_harness/__init__.py",
      "site-packages/pywin32_system32/pywintypes312.dll", "site-packages/pywin32_system32/pythoncom312.dll",
    ];
    for (const relative of requiredCritical) {
      const file = path.join(target, relative);
      if (!fs.existsSync(file) || provenance.critical_files?.[relative] !== sha256(file)) return false;
    }
    return fs.existsSync(path.join(target, "SBOM.spdx.json")) && fs.existsSync(path.join(target, "licenses"));
  } catch {
    return false;
  }
}

assertSafeLayout();
if (existingRuntimeVerified()) {
  console.log(`BROWSER_USE_RUNTIME_REUSED sha256_lock=${sha256(lockPath)}`);
  process.exit(0);
}
fs.mkdirSync(cache, { recursive: true });
fs.mkdirSync(wheelhouse, { recursive: true });
if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });

try {
  const pythonZip = download(PYTHON_URL, path.join(cache, path.basename(new URL(PYTHON_URL).pathname)));
  const chromeZip = download(CHROME_URL, path.join(cache, path.basename(new URL(CHROME_URL).pathname).replace("chrome-win64", `chrome-${CHROME_VERSION}-win64`)));

  run("python", ["-m", "pip", "download", "--quiet", "--disable-pip-version-check", "--dest", wheelhouse,
    "--platform", "win_amd64", "--python-version", "3.12", "--implementation", "cp", "--abi", "cp312",
    "--only-binary=:all:", `browser-use==${BROWSER_USE_VERSION}`]);
  const wheels = fs.readdirSync(wheelhouse).filter((file) => file.toLowerCase().endsWith(".whl")).sort().map((file) => ({
    file,
    bytes: fs.statSync(path.join(wheelhouse, file)).size,
    sha256: sha256(path.join(wheelhouse, file)),
  }));
  if (!wheels.length) throw new Error("pip produced no Browser Use wheels");

  const nextLock = {
    schema_version: 1,
    browser_use: { version: BROWSER_USE_VERSION, commit: BROWSER_USE_COMMIT },
    browser_harness: { version: BROWSER_HARNESS_VERSION, commit: BROWSER_HARNESS_COMMIT },
    python: { version: PYTHON_VERSION, url: PYTHON_URL, bytes: pythonZip.bytes, sha256: pythonZip.sha256 },
    chrome_for_testing: { version: CHROME_VERSION, url: CHROME_URL, bytes: chromeZip.bytes, sha256: chromeZip.sha256 },
    wheels,
  };
  enforceExistingLock(readExistingLock(), nextLock);

  extract(pythonZip.file, path.join(build, "python"));
  extract(chromeZip.file, path.join(build, "chrome"));
  const pth = path.join(build, "python", "python312._pth");
  // The embeddable distribution does not process pywin32.pth for an
  // externally listed target directory. List pywin32's portable paths
  // explicitly so mcp's Windows stdio transport can import pywintypes.
  fs.writeFileSync(pth, [
    "python312.zip",
    ".",
    "../site-packages",
    "../site-packages/win32",
    "../site-packages/win32/lib",
    "../site-packages/pythonwin",
    "import site",
    "",
  ].join("\r\n"), "utf8");
  const sitePackages = path.join(build, "site-packages");
  fs.mkdirSync(sitePackages, { recursive: true });
  run("python", ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-index", "--find-links", wheelhouse,
    "--target", sitePackages, "--no-compile", "--only-binary=:all:",
    "--platform", "win_amd64", "--python-version", "3.12", "--implementation", "cp", "--abi", "cp312",
    `browser-use==${BROWSER_USE_VERSION}`]);

  const packages = installedPackages(sitePackages);
  const browserUse = packages.find((pkg) => pkg.name.toLowerCase() === "browser-use");
  const browserHarness = packages.find((pkg) => pkg.name.toLowerCase() === "browser-harness");
  if (browserUse?.version !== BROWSER_USE_VERSION || browserHarness?.version !== BROWSER_HARNESS_VERSION) {
    throw new Error(`Unexpected Browser Use package versions: ${browserUse?.version}/${browserHarness?.version}`);
  }

  const licenses = path.join(build, "licenses");
  copyLicenses(packages, path.join(licenses, "python-packages"));
  const browserUseSource = "D:\\web_harness_z8_business\\five-repo-study-20260912\\snapshots\\browser-use-0.13.10";
  const browserHarnessSource = "D:\\web_harness_z8_business\\five-repo-study-20260912\\snapshots\\browser-harness-0.1.13";
  for (const [source, name] of [[browserUseSource, "Browser-Use-LICENSE"], [browserHarnessSource, "Browser-Harness-LICENSE"]]) {
    const file = path.join(source, "LICENSE");
    if (!fs.existsSync(file)) throw new Error(`Pinned source license is missing: ${file}`);
    fs.copyFileSync(file, path.join(licenses, `${name}.txt`));
  }
  const pythonLicense = path.join(build, "python", "LICENSE.txt");
  if (fs.existsSync(pythonLicense)) fs.copyFileSync(pythonLicense, path.join(licenses, "Python-LICENSE.txt"));
  fs.writeFileSync(path.join(licenses, "Chrome-for-Testing-NOTICE.txt"),
    `Chrome for Testing ${CHROME_VERSION}\nOfficial artifact: ${CHROME_URL}\nChrome licensing information is available from chrome://credits in the bundled binary and https://www.google.com/chrome/terms/.\n`, "utf8");

  const criticalFiles = {};
  for (const relative of [
    "python/python.exe", "python/python312.dll", "chrome/chrome-win64/chrome.exe",
    "site-packages/browser_use/__init__.py", "site-packages/browser_harness/__init__.py",
    "site-packages/pywin32_system32/pywintypes312.dll", "site-packages/pywin32_system32/pythoncom312.dll",
  ]) {
    const file = path.join(build, relative);
    if (!fs.existsSync(file)) throw new Error(`Critical Browser runtime file is missing: ${relative}`);
    criticalFiles[relative.replaceAll("\\", "/")] = sha256(file);
  }
  const provenance = {
    ...nextLock,
    built_at: new Date().toISOString(),
    telemetry_default: "disabled",
    critical_files: criticalFiles,
  };
  fs.writeFileSync(path.join(build, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(build, "SBOM.spdx.json"), `${JSON.stringify(makeSpdx(packages, [
    { name: "Python-embeddable", version: PYTHON_VERSION, url: PYTHON_URL, sha256: pythonZip.sha256, license: "Python-2.0" },
    { name: "Chrome-for-Testing", version: CHROME_VERSION, url: CHROME_URL, sha256: chromeZip.sha256, license: "NOASSERTION" },
  ]), null, 2)}\n`, "utf8");

  const embeddedPython = path.join(build, "python", "python.exe");
  const probeEnv = {
    ...process.env,
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1",
    ANONYMIZED_TELEMETRY: "false",
    BROWSER_USE_CLOUD_SYNC: "false",
    BH_TELEMETRY: "0",
    BROWSER_HARNESS_TELEMETRY: "0",
    BH_UPDATE_CHECK: "0",
    BH_DOMAIN_SKILLS: "0",
  };
  const probe = run(embeddedPython, ["-c", "import browser_use, browser_harness, mcp; from browser_use.utils import get_browser_use_version; print(get_browser_use_version())"], {
    capture: true,
    env: probeEnv,
  });
  if (!probe.split(/\r?\n/).includes(BROWSER_USE_VERSION)) throw new Error(`Embedded Python import probe returned: ${probe}`);

  fs.mkdirSync(vendorRoot, { recursive: true });
  const backup = `${target}.previous-${process.pid}`;
  if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  try { fs.renameSync(build, target); }
  catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
    throw error;
  }
  if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(nextLock, null, 2)}\n`, "utf8");

  const totalBytes = walk(target).reduce((sum, file) => sum + fs.statSync(file).size, 0);
  console.log(`BROWSER_USE_RUNTIME_READY files=${walk(target).length} bytes=${totalBytes} sha256_lock=${sha256(lockPath)}`);
} finally {
  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
}
