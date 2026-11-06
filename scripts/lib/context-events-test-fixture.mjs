import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { register } from 'tsx/esm/api';
import ts from 'typescript';

register();
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function setup(label) {
  const evidence = path.join(repo, '.validation/resume-context-events-20261106');
  await fs.mkdir(evidence, { recursive: true });
  const run = await fs.mkdtemp(path.join(evidence, `${label}-`));
  const workspace = path.join(run, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  Object.assign(process.env, {
    CODEX_HOME: path.join(run, 'codex'), AUDIT_LOG_PATH: path.join(run, 'audit.log'),
    CHECKPOINT_PATH: path.join(run, 'checkpoints'), CHATGPT_PLUGINS_CONFIG: path.join(run, 'plugins.json'),
    MCP_UPSTREAM_CONFIG: path.join(run, 'upstream.json'), CHATGPT_TOOL_PROFILE: 'slim',
    HARNESS_ACCOUNT_ID: 'bounded-fixture-principal', CHATGPT_TUNNEL_PROFILE: 'bounded-fixture-tunnel',
    HARNESS_STATE_CACHE_TTL_MS: '0', HARNESS_CONTEXT_CACHE_MAX_ENTRIES: '4', HARNESS_CONTEXT_CACHE_IDLE_MS: '600000',
    HARNESS_EVENT_CACHE_MAX_ENTRIES: '4', HARNESS_EVENT_CACHE_IDLE_MS: '600000',
    MCP_SSE_EVENT_STORE_ENABLED: 'false', HARNESS_INVOCATION_TRACE: 'off',
  });
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
  await fs.writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), '[plugins]\n');
  await fs.writeFile(process.env.CHATGPT_PLUGINS_CONFIG, '{"schema_version":2,"skills":[],"browser_use":{"enabled":false},"computer_use":{"enabled":false}}\n');
  await fs.writeFile(process.env.MCP_UPSTREAM_CONFIG, '{"version":1,"servers":[]}\n');
  process.chdir(run);
  return { run, workspace };
}
export const source = file => import(pathToFileURL(path.join(repo, 'src', file)).href);
export async function instrument(run, file, transform = value => value) {
  const original = await fs.readFile(path.join(repo, 'src/lib', file), 'utf8');
  const changed = transform(original);
  const transpiled = ts.transpileModule(changed, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(
    /(from\s*['"])(\.[^'"]+\.js)(['"])/g,
    (_match, before, target, after) => `${before}${pathToFileURL(path.resolve(repo, 'src/lib', target.replace(/\.js$/, '.ts'))).href}${after}`,
  );
  const target = path.join(run, `${file}.instrumented.mjs`);
  await fs.writeFile(target, transpiled);
  return { module: await import(pathToFileURL(target).href), url: pathToFileURL(target).href };
}
export async function signatures(files) {
  return Promise.all(files.map(async file => ({ path: file, sha256: createHash('sha256').update(await fs.readFile(path.join(repo, file))).digest('hex') })));
}
export async function receipt(run, files, records) {
  const value = { passed: true, mode: 'isolated source/in-process and file fixtures; no listener, browser, native process, Office, or live service', source: await signatures(files), records, finished_at: new Date().toISOString() };
  await fs.writeFile(path.join(run, 'receipt.json'), `${JSON.stringify(value, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, run, records }));
}
