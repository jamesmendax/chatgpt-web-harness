import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { globFiles } from "../dist/lib/glob-search.js";
import { grepSearch } from "../dist/lib/grep-search.js";
import { applyMultiFilePatch, applyUnifiedPatchToText, isMultiFilePatch } from "../dist/lib/patch.js";
import { decodeBase64Strict, isProxySyntheticIp, streamResponseBodyToFile } from "../dist/tools/filesystem.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".tool-test-tmp");

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

await fs.mkdir(tmpDir, { recursive: true });

await run("glob finds typescript files", async () => {
  const matches = await globFiles(root, "src/**/*.ts", 50);
  if (matches.length === 0 || matches.length > 50) throw new Error(`unexpected match count ${matches.length}`);
});

await run("glob **/ includes root files and bounds collected matches", async () => {
  const globRoot = await fs.mkdtemp(path.join(tmpDir, "glob-limit-"));
  await fs.mkdir(path.join(globRoot, "nested"), { recursive: true });
  const fixtures = [
    [path.join(globRoot, "root.txt"), 1],
    [path.join(globRoot, "nested", "old.txt"), 2],
    [path.join(globRoot, "nested", "newest.txt"), 4],
    [path.join(globRoot, "later.txt"), 3],
  ];
  for (const [filePath, seconds] of fixtures) {
    await fs.writeFile(filePath, String(seconds), "utf8");
    await fs.utimes(filePath, seconds, seconds);
  }
  const all = await globFiles(globRoot, "**/*.txt", 10);
  if (!all.some((match) => match.path === path.join(globRoot, "root.txt"))) {
    throw new Error("root-level file was omitted by **/ pattern");
  }
  const limited = await globFiles(globRoot, "**/*.txt", 2);
  if (limited.length !== 2) {
    throw new Error(`expected two bounded matches, got ${limited.length}`);
  }
  for (let index = 1; index < limited.length; index++) {
    if (limited[index - 1].mtimeMs < limited[index].mtimeMs) {
      throw new Error("bounded matches were not sorted by mtime");
    }
  }
  await fs.rm(globRoot, { recursive: true, force: true });
});

await run("grep content mode", async () => {
  const out = await grepSearch({ pattern: "registerFilesystemTools", path: path.join(root, "src"), glob: "*.ts", headLimit: 10 });
  if (!out.includes("filesystem.ts")) throw new Error("pattern not found");
});

await run("grep files_with_matches mode", async () => {
  const out = await grepSearch({
    pattern: "createMcpServer",
    path: path.join(root, "src"),
    glob: "*.ts",
    outputMode: "files_with_matches",
    headLimit: 10,
  });
  if (!out.includes("server-factory")) throw new Error("file not listed");
});

await run("apply_patch codex style", async () => {
  const file = path.join(tmpDir, "sample.txt");
  await fs.writeFile(file, "hello\nworld\n");
  const next = applyUnifiedPatchToText("hello\nworld\n", "@@\n-hello\n+hi\n world\n");
  if (!next.includes("hi")) throw new Error("patch failed");
});

await run("read offset/limit simulation", async () => {
  const file = path.join(tmpDir, "lines.txt");
  await fs.writeFile(file, "a\nb\nc\nd\n");
  const lines = (await fs.readFile(file, "utf-8")).split("\n");
  const slice = lines.slice(1, 3);
  if (slice.join(",") !== "b,c") throw new Error(`unexpected ${slice}`);
});

await run("edit replace_all simulation", async () => {
  const file = path.join(tmpDir, "repeat.txt");
  await fs.writeFile(file, "foo bar foo");
  const content = await fs.readFile(file, "utf-8");
  const next = content.split("foo").join("baz");
  await fs.writeFile(file, next);
  const result = await fs.readFile(file, "utf-8");
  if (result !== "baz bar baz") throw new Error(result);
});

await run("strict base64 accepts valid binary payload", async () => {
  const decoded = decodeBase64Strict("AAEC/w==");
  if (!decoded.equals(Buffer.from([0, 1, 2, 255]))) throw new Error("decoded bytes mismatch");
});

await run("strict base64 rejects malformed payload", async () => {
  let threw = false;
  try {
    decodeBase64Strict("not@@base64");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("malformed base64 was accepted");
});

await run("strict base64 preserves real PNG binary bytes", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlTtGQAAAAASUVORK5CYII=",
    "base64"
  );
  const decoded = decodeBase64Strict(png.toString("base64"));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!decoded.equals(png)) throw new Error("PNG bytes changed during base64 round-trip");
  if (!decoded.subarray(0, 8).equals(signature)) throw new Error("PNG signature mismatch");
});

await run("Clash fake-IP range is recognized without opening literal private IP URLs", async () => {
  if (!isProxySyntheticIp("198.18.0.81")) throw new Error("198.18/15 fake IP was not recognized");
  if (!isProxySyntheticIp("198.19.255.254")) throw new Error("198.19/15 fake IP was not recognized");
  if (isProxySyntheticIp("198.20.0.1")) throw new Error("non fake-IP range was misclassified");
  if (isProxySyntheticIp("10.0.0.1")) throw new Error("private LAN IP was misclassified as proxy synthetic");
});

await run("ChatGPT attachment response streams original bytes with SHA256", async () => {
  const file = path.join(tmpDir, "chatgpt-stream.bin");
  const payload = Buffer.concat([Buffer.from("chatgpt-file-transfer\n"), Buffer.alloc(256 * 1024, 0x5a)]);
  const expectedSha256 = createHash("sha256").update(payload).digest("hex");
  const response = new Response(payload, { headers: { "content-length": String(payload.length) } });
  const result = await streamResponseBodyToFile(response, file, payload.length + 1);
  const actual = await fs.readFile(file);
  if (!actual.equals(payload)) throw new Error("streamed attachment bytes changed");
  if (result.bytes !== payload.length) throw new Error(`streamed byte count ${result.bytes}`);
  if (result.sha256 !== expectedSha256) throw new Error("streamed attachment SHA256 mismatch");
});

await run("ChatGPT attachment streaming enforces max byte limit", async () => {
  const file = path.join(tmpDir, "chatgpt-stream-too-large.bin");
  const response = new Response(Buffer.alloc(64, 0x41));
  let threw = false;
  try {
    await streamResponseBodyToFile(response, file, 32);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("oversized attachment was accepted");
});

await run("multi-file patch detection", async () => {
  const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-hello
+hi
*** End Patch`;
  if (!isMultiFilePatch(patch)) throw new Error("should detect multi-file patch");
});

await run("multi-file patch apply", async () => {
  const file = path.join(tmpDir, "multi.txt");
  await fs.writeFile(file, "alpha\nbeta\n");
  const patch = `*** Begin Patch
*** Update File: multi.txt
@@
-alpha
+gamma
 beta
*** End Patch`;
  const results = await applyMultiFilePatch(patch, { base_dir: tmpDir });
  if (results.length !== 1 || !results[0].ok) throw new Error(JSON.stringify(results));
  const text = await fs.readFile(file, "utf-8");
  if (!text.includes("gamma")) throw new Error(text);
});

await run("delete and move file", async () => {
  const src = path.join(tmpDir, "move-me.txt");
  const dest = path.join(tmpDir, "moved.txt");
  await fs.writeFile(src, "payload");
  await fs.rename(src, dest);
  const text = await fs.readFile(dest, "utf-8");
  if (text !== "payload") throw new Error("move failed");
  await fs.unlink(dest);
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
