import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { closeOwnedBrowserServer } from '../dist/lib/owned-browser-cleanup.js';

function fixture(mode) {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const counts = { close: 0, kill: 0 };
  const exit = () => { child.exitCode = 0; child.emit('exit', 0); };
  return { child, counts, server: {
    process: () => child,
    close: () => { counts.close++; if (mode === 'graceful') setTimeout(exit, 2); return new Promise(() => {}); },
    kill: () => { counts.kill++; if (mode === 'force') setTimeout(exit, 2); return Promise.resolve(); },
  } };
}
const a = fixture('graceful');
await closeOwnedBrowserServer(a.server, 80);
assert.deepEqual(a.counts, { close: 1, kill: 0 });
const b = fixture('force');
await closeOwnedBrowserServer(b.server, 80);
assert.deepEqual(b.counts, { close: 1, kill: 1 });
const c = fixture('never');
await assert.rejects(closeOwnedBrowserServer(c.server, 60), /did not exit/);
assert.deepEqual(c.counts, { close: 1, kill: 1 });
for (const f of [a, b, c]) assert.equal(f.child.listenerCount('exit'), 0);
console.log('owned-browser-cleanup: graceful exit, owned forced exit, failure without exit proof, listener cleanup PASS');