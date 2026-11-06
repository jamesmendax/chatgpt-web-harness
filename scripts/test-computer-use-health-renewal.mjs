import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getProviderHealth } from '../dist/lib/provider-health.js';
import isolation from '../desktop/scripts/lib/test-isolation.cjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=isolation.artifactRoot('computer-use-health-renewal');
const helper=path.join(root,'bundled-plugins/computer-use/windows-action.ps1');
const file=path.join(tmp,'capability.json'), config=path.join(tmp,'plugins.json');
const record={schema_version:1,provider:'computer-use',account_id:'a'.repeat(32),instance_id:'fixture-instance',token:'fixture-token',issued_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString(),helper_sha256:crypto.createHash('sha256').update(await fs.readFile(helper)).digest('hex')};
Object.assign(process.env,{CHATGPT_PLUGINS_CONFIG:config,HARNESS_ACCOUNT_ID:record.account_id,HARNESS_COMPUTER_USE_CAPABILITY_FILE:file,HARNESS_COMPUTER_USE_HELPER:helper,HARNESS_COMPUTER_USE_HELPER_SHA256:record.helper_sha256,HARNESS_COMPUTER_USE_TOKEN:record.token,HARNESS_COMPUTER_USE_INSTANCE_ID:record.instance_id,HARNESS_COMPUTER_USE_EXPIRES_AT:new Date(Date.now()-60000).toISOString()});
await fs.writeFile(config,JSON.stringify({schema_version:2,computer_use:{enabled:true},skills:[]}));
await fs.writeFile(file,JSON.stringify(record));
if(process.platform==='win32'){
 assert.equal(getProviderHealth().computer_use.ready,true,'renewed file must override the stale launch-time expiry');
 await fs.writeFile(file,JSON.stringify({...record,expires_at:new Date(Date.now()-1000).toISOString()}));
 assert.equal(getProviderHealth().computer_use.ready,false);
 assert.match(getProviderHealth().computer_use.reason,/expired/);
 await fs.writeFile(file,JSON.stringify({...record,token:'wrong-fixture-token'}));
 assert.match(getProviderHealth().computer_use.reason,/token mismatch/);
 assert.equal(JSON.stringify(getProviderHealth()).includes(record.token),false);
}
console.log('PASS authoritative renewed expiry, clear expiration/token errors, secret-free health');
