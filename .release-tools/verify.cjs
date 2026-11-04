"use strict";
// Task-local verification runner. It never inherits the live Harness state or credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const taskRoot = path.join(repo, '.validation');
fs.mkdirSync(taskRoot, {recursive:true});
function resolveStandardNode() {
  if (/^node(?:\.exe)?$/i.test(path.basename(process.execPath))) return process.execPath;
  const candidates = [
    process.env.NODE_EXE,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    process.env.ProgramW6432 && path.join(process.env.ProgramW6432, 'nodejs', 'node.exe'),
    'C:\\Program Files\\nodejs\\node.exe',
  ].filter(Boolean);
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`Release verification requires a standard Node.js executable; current executable is ${process.execPath}`);
  }
  return found;
}
const node = resolveStandardNode();
const mode = process.argv[2] || 'root';
if (!['root','desktop'].includes(mode)) throw new Error('Expected root or desktop');
const runRoot = fs.mkdtempSync(path.join(taskRoot, `${mode}-`));
const workspace = path.join(runRoot, 'workspace');
const runtime = path.join(runRoot, 'runtime');
for (const dir of [workspace, runtime, path.join(runtime,'profiles')]) fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(runRoot,'empty.env'),'# No production environment\n');
fs.writeFileSync(path.join(runtime,'profiles','plugins.json'), JSON.stringify({schema_version:2,computer_use:{enabled:false},skills:[]}));
fs.writeFileSync(path.join(runtime,'profiles','mcp-upstream.json'), JSON.stringify({version:1,servers:[]}));
const env = {};
const allowed = /^(SystemRoot|windir|ComSpec|PATH|PATHEXT|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|ALLUSERSPROFILE|PROGRAMDATA)$/i;
for(const [key,value] of Object.entries(process.env)) if(allowed.test(key)) env[key]=value;
for(const key of Object.keys(env)) if(key.toLowerCase()==='path') delete env[key];
env.PATH = 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd;' + (process.env.PATH || process.env.Path || '');
Object.assign(env, {
  HOST:'127.0.0.1', WORKSPACE_PATH:workspace, FULL_DISK_ACCESS:'false',
  CODEX_HOME:path.join(runtime,'.codex'), MCP_SHELL_STATE_DIR:path.join(runtime,'.mcp-state'),
  AUDIT_LOG_PATH:path.join(runtime,'audit.log'), CHECKPOINT_PATH:path.join(runtime,'checkpoints'),
  CLC_RUNTIME_DIR:runtime, CHATGPT_PLUGINS_CONFIG:path.join(runtime,'profiles','plugins.json'),
  MCP_UPSTREAM_CONFIG:path.join(runtime,'profiles','mcp-upstream.json'),
  DOTENV_CONFIG_PATH:path.join(runRoot,'empty.env'), DOTENV_CONFIG_OVERRIDE:'false',
  MCP_TOKEN:'', ADMIN_TOKEN:'', CHATGPT_TOOL_PROFILE:'slim', SMOKE_TUNNEL_DOCTOR:'0',
  npm_config_audit:'false', npm_config_fund:'false'
});
function signature() {
  return require("./source-signature.cjs").sourceSignature(repo);
}
const before=signature();
const beforeToolchain=require("./toolchain-receipts.cjs").toolchain(repo,node);
const results=[];
fs.writeFileSync(path.join(runRoot,'source-before.json'),JSON.stringify(before,null,2));
console.log('VERIFICATION_RUN '+JSON.stringify({mode,runRoot,source_sha256:before.sha256,node}));
async function run(label,args,cwd,timeoutMs) {
  console.log('\n=== START '+label+' ===');
  const start=Date.now();
  const out=fs.createWriteStream(path.join(runRoot,label+'.log'));
  const child=spawn(node,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true; console.error('Timeout: '+label); child.kill();},timeoutMs);
  child.stdout.on('data',d=>{out.write(d);process.stdout.write(d)});
  child.stderr.on('data',d=>{out.write(d);process.stderr.write(d)});
  const finish=await new Promise(resolve=>{
    child.once('error',error=>resolve({exit_code:null,error:String(error)}));
    child.once('close',(code,signal)=>resolve({exit_code:code,signal}));
  });
  clearTimeout(timer); await new Promise(resolve=>out.end(resolve));
  const log=path.join(runRoot,label+'.log');
  const row={name:label,...finish,timed_out:timedOut,elapsed_ms:Date.now()-start,log,log_sha256:crypto.createHash('sha256').update(fs.readFileSync(log)).digest('hex'),passed:finish.exit_code===0&&!timedOut};
  if(label==='root-all' && row.passed) {
    const {fullTests}=await import('../scripts/active-test-manifest.mjs');
    const receipts=fs.readFileSync(log,'utf8').split(/\r?\n/).filter(line=>line.startsWith('TEST_RECEIPT ')).map(line=>JSON.parse(line.slice('TEST_RECEIPT '.length)));
    if(receipts.length!==fullTests.length || receipts.some((receipt,index)=>receipt.test!==fullTests[index] || receipt.exit_code!==0)) throw new Error('Root test receipts do not match the mandatory full manifest');
    row.tests=receipts;
  }
  results.push(row);
  fs.writeFileSync(path.join(runRoot,'results.json'),JSON.stringify({mode,source_sha256:before.sha256,results,complete:false},null,2));
  console.log('VERIFICATION_STEP '+JSON.stringify(row));
  if(!row.passed) throw new Error(label+' failed');
}
(async()=>{
  if(mode==='root') {
    await run('root-all',['scripts/run-all-tests.mjs'],repo,900000);
    await run('upstream',['scripts/test-mcp-upstream.mjs'],repo,180000);
    await run('oauth',['scripts/test-mcp-oauth.mjs'],repo,180000);
    await run('bridge',['scripts/test-mcp-bridge-integration.mjs'],repo,180000);
  } else {
    await run('desktop-all',[path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npm-cli.js'),'test'],path.join(repo,'desktop'),600000);
  }
  const after=signature();
  if(after.sha256!==before.sha256) throw new Error('Source changed during verification; results are stale');
  require("node:assert/strict").deepEqual(require("./toolchain-receipts.cjs").toolchain(repo,node),beforeToolchain,"Toolchain changed during verification");
  const summary={mode,runRoot,source_sha256:after.sha256,toolchain:beforeToolchain,results,complete:true,passed:true,completed_at:new Date().toISOString()};
  fs.writeFileSync(path.join(runRoot,'results.json'),JSON.stringify(summary,null,2));
  fs.writeFileSync(path.join(taskRoot,mode+'-latest.json'),JSON.stringify(summary,null,2));
  console.log('VERIFICATION_COMPLETE '+JSON.stringify(summary));
})().catch(error=>{
  console.error(error.stack||error);
  fs.writeFileSync(path.join(runRoot,'failure.json'),JSON.stringify({mode,source_sha256:before.sha256,results,error:String(error),complete:false,passed:false},null,2));
  process.exitCode=1;
});
