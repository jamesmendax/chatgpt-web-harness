const assert = require('node:assert/strict');
const capability = require('../src/computer-use-capability');
const account = 'a'.repeat(32), other = 'b'.repeat(32), hash = 'c'.repeat(64);
const start = Date.parse('2026-10-31T00:00:00Z');
const initial = capability.issue(account, hash, { now: start, rotate: true });
const separate = capability.issue(other, hash, { now: start, rotate: true });
let current = initial;
for (let minute=1; minute<=180; minute++) {
  const next = capability.renew(account, hash, { now: start + minute * 60_000 });
  assert.ok(next);
  assert.equal(next.token, initial.token);
  assert.equal(next.instance_id, initial.instance_id);
  assert.equal(next.issued_at, initial.issued_at);
  assert.ok(Date.parse(next.expires_at) > start + minute * 60_000);
  current = next;
}
assert.ok(Date.parse(current.expires_at) > Date.parse(initial.expires_at));
assert.equal(capability.issue(other, hash, { now: start + 1 }).token, separate.token);
assert.throws(() => capability.renew(account, 'd'.repeat(64), { now: start }), /helper/i);
capability.revoke(account);
assert.equal(capability.renew(account, hash, { now: start }), null, 'revocation must not recreate a capability');
const rotated = capability.issue(account, hash, { now: start, rotate: true });
assert.notEqual(rotated.token, initial.token);
console.log('PASS three-hour renewal keeps live identity; account isolation, helper integrity, revocation and rotation');
