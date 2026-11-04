import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeRecoveryJson, publishRecoveryFile } from "../dist/lib/recovery-atomic-write.js";

const root=await fs.mkdtemp(path.join(os.tmpdir(),"recovery-atomic-write-"));
const target=path.join(root,"state.json"),realRename=fs.rename;
let transientAttempts=0;
try{
 fs.rename=async(...args)=>{transientAttempts++;if(transientAttempts<=2)throw Object.assign(new Error("test sharing violation"),{code:"EPERM"});return realRename(...args);};
 await writeRecoveryJson(target,{phase:"initial",revision:1});
 assert.equal(transientAttempts,3);
 assert.deepEqual(JSON.parse(await fs.readFile(target,"utf8")),{phase:"initial",revision:1});
 fs.rename=realRename;

 let calls=0;
 fs.rename=async(...args)=>{calls++;if(calls===1)await new Promise(r=>setTimeout(r,80));return realRename(...args);};
 await Promise.all(Array.from({length:16},(_,i)=>writeRecoveryJson(target,{phase:i===15?"completed":"running",revision:i+2})));
 assert.deepEqual(JSON.parse(await fs.readFile(target,"utf8")),{phase:"completed",revision:17},"a delayed earlier heartbeat must not overwrite the final state");
 fs.rename=realRename;

 const content=JSON.stringify({task_id:"concurrent",payload:"x".repeat(600000)});
 const publicationFile=path.join(root,"plan.json");
 const publications=await Promise.all(Array.from({length:12},async()=>{
   const result=await publishRecoveryFile(publicationFile,content);
   assert.equal(await fs.readFile(publicationFile,"utf8"),content,"published plan must already be complete");
   return result;
 }));
 assert.equal(publications.filter(x=>x==="created").length,1);
 assert.equal(publications.filter(x=>x==="exists").length,11);

 let denied=0;
 fs.rename=async()=>{denied++;throw Object.assign(new Error("test persistent denial"),{code:"EACCES"});};
 await assert.rejects(writeRecoveryJson(target,{phase:"must-not-publish"}),/persistent denial/);
 assert.equal(denied,8,"persistent failure must remain bounded and visible");
 assert.equal(JSON.parse(await fs.readFile(target,"utf8")).phase,"completed");
 fs.rename=realRename;
 assert.equal((await fs.readdir(root)).some(n=>n.endsWith(".tmp")),false);
 console.log(JSON.stringify({test:"recovery-atomic-write",status:"PASS",transient_attempts:transientAttempts,serialized_revisions:16,concurrent_publications:12,exclusive_publishers:1,persistent_denial_attempts:denied}));
}finally{fs.rename=realRename;await fs.rm(root,{recursive:true,force:true});}
