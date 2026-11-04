"use strict";
// No personal profile; one encrypted test value moves between two new Electron userData roots.
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {spawnSync}=require("node:child_process");
const fixtureText="synthetic-key-nonsecret";
const dir=process.argv[2]==="__target" ? process.argv[4] : null;
if (dir) {
  const {app,safeStorage}=require("electron");
  const source=process.argv[3],cipher=process.argv[5],output=process.argv[6];
  fs.mkdirSync(dir,{recursive:true});
  app.setPath("userData",dir);
  app.whenReady().then(async()=>{
    const enc=fs.readFileSync(cipher,"utf8");
    const decoded=await require("../src/legacy-crypto").decryptFromSource({
      sourceRoot:source,apiKeyEnc:enc,adminTokenEnc:""
    });
    assert.equal(decoded.apiKey,fixtureText);
    const saved=safeStorage.encryptString(decoded.apiKey);
    assert.equal(safeStorage.decryptString(saved),fixtureText);
    if(output)fs.writeFileSync(output,saved.toString("base64"));
    console.log("PASS isolated native source-profile decrypt and target re-encrypt");
    app.exit(0);
  }).catch(e=>{console.error("FAILED target bridge: "+e.message);app.exit(1);});
} else {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"wh-bridge-native-test-"));
  const source=path.join(root,"source"),target=path.join(root,"target"),
    future=path.join(root,"future"),cipher=path.join(root,"cipher.txt"),cipherB=path.join(root,"cipher-b.txt");
  const electronPath=require("electron"),env={...process.env};
  delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const run=(script,args)=>{
    const r=spawnSync(electronPath,[script,...args],{env,cwd:path.resolve(__dirname,".."),windowsHide:true,encoding:"utf8",timeout:65000});
    assert.equal(r.status,0,"native fixture failed: "+String(r.stderr||r.stdout).slice(0,1100));
    return r.stdout;
  };
  try {
    run(path.join(__dirname,"test-legacy-crypto-context.cjs"),["__child","encrypt",source,cipher]);
    assert.ok(fs.existsSync(path.join(source,"Local State")));
    const response=run(__filename,["__target",source,target,cipher,cipherB]);
    assert.match(response,/PASS isolated native source-profile/);
    assert.ok(fs.existsSync(path.join(target,"Local State")));
    const futureResponse=run(__filename,["__target",target,future,cipherB]);
    assert.match(futureResponse,/PASS isolated native source-profile/);
    console.log("PASS synthetic native A-to-B-to-C migration; each hop re-encrypts with its own context");
  } finally {
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}
