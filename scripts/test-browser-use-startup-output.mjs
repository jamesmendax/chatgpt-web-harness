import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.env.HARNESS_TEST_ROOT || new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const dist = path.resolve(process.env.HARNESS_TEST_DIST || path.join(root, 'dist'));
const { probeOwnedChromeCdp, browserUsePhysicalDataDirectory } = await import(pathToFileURL(path.join(dist, 'lib/browser-use-provider.js')));
const { wrapBrowserUseResult } = await import(pathToFileURL(path.join(dist, 'tools/browser-use.js')));
let mode = 'valid'; let requests = 0;
const server = http.createServer((req, res) => {
  requests += 1;
  assert.equal(req.url, '/json/version');
  const port = server.address().port;
  if (mode === 'hang') return;
  if (mode === 'redirect') { res.writeHead(302, { location: 'http://192.0.2.1/' }); res.end(); return; }
  if (mode === 'large') { res.end('x'.repeat(40000)); return; }
  if (mode === 'invalid-json') { res.end('{'); return; }
  if (mode === 'missing') { res.end('{}'); return; }
  const endpoint = mode === 'external' ? `ws://192.0.2.1:${port}/devtools/browser/test` :
    mode === 'wrong-port' ? 'ws://127.0.0.1:1/devtools/browser/test' : `ws://127.0.0.1:${port}/devtools/browser/test`;
  res.end(JSON.stringify({ webSocketDebuggerUrl: endpoint }));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;
const checks = [];
try {
  await probeOwnedChromeCdp(port); checks.push('owned-loopback-ready');
  for (const invalid of ['external', 'wrong-port', 'redirect', 'large', 'invalid-json', 'missing']) {
    mode = invalid; const before = requests;
    await assert.rejects(() => probeOwnedChromeCdp(port, 500));
    assert.equal(requests, before + 1); checks.push(`reject-${invalid}`);
  }
  mode = 'hang'; const start = Date.now();
  await assert.rejects(() => probeOwnedChromeCdp(port, 100), /deadline/);
  assert.ok(Date.now() - start < 2000); checks.push('bounded-hung-probe');
  await assert.rejects(() => probeOwnedChromeCdp(0), /Invalid/); checks.push('reject-invalid-port');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
const input = { content: [{ type: 'text', text: 'plain stdout\n\u6210\u529f' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] };
const output = wrapBrowserUseResult('browser_exec', input);
assert.equal(output.structuredContent.data.output, 'plain stdout\n\u6210\u529f');
assert.equal(output.structuredContent.data.output_truncated, false);
assert.ok(output.content.some(item => item.type === 'image' && item.data === input.content[1].data));
assert.ok(output.content.some(item => item.type === 'text' && item.text === input.content[0].text));
checks.push('plain-unicode-stdout-and-image-preserved');
const failure = wrapBrowserUseResult('browser_exec', { isError: true, content: [{ type: 'text', text: 'upstream failure' }] });
assert.equal(failure.structuredContent.ok, false); assert.equal(failure.isError, true); checks.push('error-semantics-preserved');
const long = wrapBrowserUseResult('browser_exec', { content: [{ type: 'text', text: 'x'.repeat(25000) }] });
assert.equal(long.structuredContent.data.output.length, 24000); assert.equal(long.structuredContent.data.output_chars, 25000);
assert.equal(long.structuredContent.data.output_truncated, true); assert.equal(long.content[0].text.length, 25000);
checks.push('bounded-preview-full-mcp-content-retained');
const helper = fs.readFileSync(path.join(root, 'bundled-plugins/computer-use/windows-action.ps1'), 'utf8');
assert.match(helper, /Console\]::InputEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]/);
assert.match(helper, /EnablePhysicalCoordinates\(\)/); assert.match(helper, /SetThreadDpiAwarenessContext/);
assert.match(helper, /capability/); checks.push('computer-use-utf8-physical-coordinates');
if (process.platform === 'win32') {
  const logical = path.join(root, 'retained-path-test', 'a'.repeat(100), crypto.randomUUID());
  const physical = browserUsePhysicalDataDirectory(logical);
  assert.ok(path.join(physical, 'profile').length <= 150);
  assert.match(path.basename(physical), /^[0-9a-f]{64}$/);
  assert.equal(browserUsePhysicalDataDirectory(logical), physical);
  assert.notEqual(browserUsePhysicalDataDirectory(logical + '-other-account-or-generation'), physical);
  assert.equal(fs.existsSync(logical), false);
  checks.push('short-path-full-digest-isolation-and-idempotency');
  const wrongLogical = logical + '-foreign';
  const identity = crypto.createHash('sha256').update(JSON.stringify(['browser-use-physical-v1', path.resolve(wrongLogical).toLowerCase()])).digest('hex');
  const foreign = path.join(path.dirname(physical), identity);
  fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'owner.json'), 'not-owned', { flag: 'wx' });
  assert.throws(() => browserUsePhysicalDataDirectory(wrongLogical), /ownership mismatch/);
  assert.equal(fs.readFileSync(path.join(foreign, 'owner.json'), 'utf8'), 'not-owned');
  checks.push('foreign-short-path-not-adopted-or-modified');
}
console.log(JSON.stringify({ status: 'PASS', checks, count: checks.length, deleted_files: false, browser_ui_acceptance: false }));
