import assert from 'node:assert/strict';
import { scopedOperationIdentity, operationRequestMetadata } from '../dist/lib/mcp-request-identity.js';

const owner = { principalId: 'fixture', tunnelProfile: 'a', conversationSessionId: 'conversation' };
const key = (session, id, explicit) => scopedOperationIdentity(owner, session, id, explicit);
assert.equal(key('s1', 0), key('s1', 0));
assert.notEqual(key('s1', 0), key('s2', 0), 'new transport can reset its RPC counter');
assert.notEqual(key('s1', 0), key('s1', '0'), 'typed RPC IDs must not collide');
assert.equal(key('s1', 1, 'operation-a'), key('s2', 9, 'operation-a'), 'explicit identity survives reconnect');
assert.notEqual(key('s1', 1, 'operation-a'), key('s1', 1, 'operation-b'));
assert.notEqual(key('s1', 1, 'operation-a'), scopedOperationIdentity({ ...owner, principalId: 'other' }, 's1', 1, 'operation-a'));
assert.notEqual(key('s1', 1, 'operation-a'), scopedOperationIdentity({ ...owner, conversationSessionId: 'other' }, 's1', 1, 'operation-a'));
assert.equal(scopedOperationIdentity({}, undefined, 0), undefined);
assert.equal(scopedOperationIdentity(owner, undefined, 0), undefined, 'conversation alone cannot namespace RPC IDs');
assert.deepEqual(operationRequestMetadata({ 'local-coder/operation-id': 'a', 'local-coder/operation-mode': 'observe' }), { id: 'a', observe: true });
assert.throws(() => operationRequestMetadata({ 'local-coder/operation-mode': 'observe' }), /REQUIRED/);
assert.throws(() => operationRequestMetadata({ 'local-coder/operation-id': '../escape' }), /INVALID/);
assert.throws(() => operationRequestMetadata({ 'local-coder/operation-mode': 'replay-anyway' }), /INVALID/);
console.log('operation identity: 13 assertions passed');
