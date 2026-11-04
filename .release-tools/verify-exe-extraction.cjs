"use strict";
const fs=require("node:fs"), path=require("node:path"), os=require("node:os"), crypto=require("node:crypto"), assert=require("node:assert/strict"), {spawnSync}=require("node:child_process");
function hash(file){return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");}
function manifest(root){const rows=[];function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isSymbolicLink())throw Error(`Extraction contains a link: ${file}`);if(e.isDirectory())visit(file);else if(e.isFile())rows.push({path:path.relative(root,file).replaceAll("\\","/"),bytes:fs.statSync(file).size,sha256:hash(file)});else throw Error(`Unexpected extracted entry: ${file}`);}}visit(root);return rows.sort((a,b)=>a.path.localeCompare(b.path));}
function expectedRuntimeForTarget(reference,target,inputs) {
  const rows=new Map(reference.map(row=>[row.path,row]));
  const applicable=(inputs||[]).filter(row=>row.target===target);
  if(target==="nsis")assert.equal(applicable.length,1,"Missing exact NSIS helper receipt");
  else assert.equal(applicable.length,0,"Unexpected Portable extra input");
  for(const input of applicable){
    assert.equal(input.path,"resources/elevate.exe","Unreviewed target-specific runtime file");
    assert.equal(hash(input.file),input.sha256,"Target-specific build input changed");
    assert.equal(fs.statSync(input.file).size,input.bytes,"Target-specific build input size changed");
    const row={path:input.path,bytes:input.bytes,sha256:input.sha256};
    if(rows.has(input.path))assert.deepEqual(rows.get(input.path),row,"Target-specific runtime bytes differ from shared runtime");
    rows.set(input.path,row);
  }
  return [...rows.values()].sort((a,b)=>a.path.localeCompare(b.path));
}
function verifyExeExtraction(repo,output,artifacts,referenceRoot,targetRuntimeInputs) {
  const work=fs.mkdtempSync(path.join(os.tmpdir(),"harness-exe-inspection-"));
  try {
    const vendor=path.join(repo,"desktop/node_modules/electron-winstaller/vendor");
    const executable=path.join(work,"7z.exe");
    fs.copyFileSync(path.join(vendor,"7z-x64.exe"),executable);
    fs.copyFileSync(path.join(vendor,"7z-x64.dll"),path.join(work,"7z.dll"));
    const expected=manifest(path.join(referenceRoot,"resources/harness"));
    const expectedRuntime=manifest(referenceRoot);
    const expectedAsar=hash(path.join(referenceRoot,"resources/app.asar"));
    const checks=[];
    const extract=(archive,dest,patterns=[])=>{
      fs.mkdirSync(dest,{recursive:true});
      const result=spawnSync(executable,["x","-y","-bso0","-bsp0",`-o${dest}`,archive,...patterns],{encoding:"utf8",windowsHide:true,timeout:900000,maxBuffer:4*1024*1024});
      if(result.error||result.status!==0)throw Error(`EXE extraction failed: ${path.basename(archive)}: ${result.error || result.stderr || result.stdout}`);
    };
    for(const artifact of artifacts){
      const file=path.join(output,artifact.name), outer=path.join(work,artifact.name.endsWith("-setup.exe")?"setup-outer":"portable"), dest=artifact.name.endsWith("-setup.exe")?path.join(work,"setup-payload"):outer;
      assert.equal(hash(file),artifact.sha256,`Executable changed before extraction: ${artifact.name}`);
      if(artifact.name.endsWith("-setup.exe")){
        extract(file,outer,["$PLUGINSDIR/app-64.7z"]);
        extract(path.join(outer,"$PLUGINSDIR","app-64.7z"),dest);
      }else if(artifact.name.endsWith("-portable.exe")) extract(file,dest);
      else throw Error(`Unexpected executable: ${artifact.name}`);
      assert.deepEqual(manifest(path.join(dest,"resources/harness")),expected,`Extracted payload differs: ${artifact.name}`);
      assert.equal(hash(path.join(dest,"resources/app.asar")),expectedAsar,`Extracted ASAR differs: ${artifact.name}`);
      const bootstrapFiles=new Set(artifact.name.endsWith("-portable.exe")?["$PLUGINSDIR/System.dll","$PLUGINSDIR/StdUtils.dll"]:[]);
      const extractedRuntime=manifest(dest).filter(row=>!bootstrapFiles.has(row.path));
      const target=artifact.name.endsWith("-setup.exe")?"nsis":"portable";
      const targetExpected=expectedRuntimeForTarget(expectedRuntime,target,targetRuntimeInputs);
      assert.deepEqual(extractedRuntime,targetExpected,`Extracted complete runtime differs: ${artifact.name}`);
      const finalHash=hash(file);
      assert.equal(finalHash,artifact.sha256,`Executable changed during extraction: ${artifact.name}`);
      checks.push({name:artifact.name,sha256:finalHash,payload_files:expected.length,runtime_files:targetExpected.length,app_asar_sha256:expectedAsar,target_inputs:(targetRuntimeInputs||[]).filter(row=>row.target===target).map(({file,...row})=>row)});
    }
    assert.equal(checks.length,2,"Both EXEs must be extracted");
    return checks;
  } finally {fs.rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
module.exports={verifyExeExtraction,expectedRuntimeForTarget};
