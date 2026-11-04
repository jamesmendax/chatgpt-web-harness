"use strict";
const assert=require("node:assert/strict"),test=require("node:test"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {PassThrough}=require("node:stream");
const {SOUND_CHOICES,createNotificationSound,validateWav,applyGain,WAV_PATH}=require("../src/notification-sound");
const {STYLES,makeSound}=require("./generate-notification-sounds.cjs");
const {customPath,importCustomWav}=require("../src/notification-audio-store");
const tick=()=>new Promise(r=>setImmediate(r));
const asset=(file)=>path.join(__dirname,"..","src","assets",file);
function temp(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"wh-sound-test-"));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
}
test("five distinct deterministic original WAV sounds are packaged assets",()=>{
 assert.deepEqual(SOUND_CHOICES.map(x=>x.id),["glass","waterdrop","xylophone","bells","digital"]);
 const shas=new Set();
 for(const sound of SOUND_CHOICES) {
   const filename=asset(sound.file),bytes=fs.readFileSync(filename);
   assert.deepEqual(validateWav(bytes),bytes);
   shas.add(crypto.createHash("sha256").update(bytes).digest("hex"));
   if(sound.id!=="glass")assert.deepEqual(bytes,makeSound(sound.id));
 }
 assert.equal(shas.size,5);
 assert.equal(WAV_PATH,asset("web-harness-chime.wav"));
});
test("gain is bounded and never changes original PCM or its RIFF header",()=>{
 const bytes=makeSound("xylophone");
 assert.strictEqual(applyGain(bytes,100),bytes);
 const scaled=applyGain(bytes,50);
 assert.equal(scaled.length,bytes.length);
 assert.deepEqual(scaled.subarray(0,44),bytes.subarray(0,44));
 for(let i=44;i<bytes.length;i+=2)
   assert.ok(Math.abs(scaled.readInt16LE(i)-bytes.readInt16LE(i)/2)<=1);
 assert.notDeepEqual(scaled,bytes);
 assert.equal(bytes.readInt16LE(50),makeSound("xylophone").readInt16LE(50));
 for(const v of [-1,101,NaN,1.5])assert.throws(()=>applyGain(bytes,v),/0–100/);
});
test("account-specific native selection and explicit preview stay isolated",async()=>{
 const calls=[],cfg={a:{id:"waterdrop",volume:50},b:{id:"bells",volume:100}};
 const player=createNotificationSound({platform:"win32",getSelection:id=>cfg[id],
 readFile:async file=>fs.readFileSync(file),execute(exe,args,opts,cb){
   const stdin=new PassThrough(),parts=[];stdin.on("data",b=>parts.push(b));
   calls.push({id:args[0],stdin,cb,bytes:()=>Buffer.concat(parts)});
   return {stdin,kill(){}};
 }});
 const a=player.play("a"),dup=player.play("a"),b=player.play("b");
 assert.strictEqual(a,dup);
 await tick();
 assert.equal(calls.length,2);
 assert.deepEqual(calls[0].bytes(),applyGain(makeSound("waterdrop"),50));
 assert.deepEqual(calls[1].bytes(),makeSound("bells"));
 calls.forEach(x=>x.cb(null,"WH_CHIME_PLAYED"));
 assert.equal(await a,true);assert.equal(await b,true);
 player.dispose();
});
test("valid custom audio is stored at a fixed account-only path and selection callback is committed",t=>{
 const root=temp(t),data=makeSound("digital"),base64=data.toString("base64");
 let commits=0;
 const result=importCustomWav({accountDataDir:root,audioBase64:base64,commitConfig:()=>{commits++;}});
 assert.equal(result.bytes,data.length);assert.ok(result.durationMs>=300);
 assert.equal(commits,1);
 assert.deepEqual(fs.readFileSync(customPath(root)),data);
 assert.ok(customPath(root).startsWith(root));
});
test("failed config commit restores previous WAV, and absent old WAV is removed",t=>{
 const root=temp(t),before=makeSound("waterdrop"),after=makeSound("bells"),file=customPath(root);
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,before);
 assert.throws(()=>importCustomWav({accountDataDir:root,audioBase64:after.toString("base64"),commitConfig:()=>{throw Error("synthetic failure");}}),/synthetic failure/);
 assert.deepEqual(fs.readFileSync(file),before);
 fs.rmSync(file);
 assert.throws(()=>importCustomWav({accountDataDir:root,audioBase64:after.toString("base64"),commitConfig:()=>{throw Error("synthetic failure");}}),/synthetic failure/);
 assert.equal(fs.existsSync(file),false);
});
test("invalid MIME bytes, extension tricks and oversized source cannot reach settings commit",t=>{
 const root=temp(t);let committed=0;
 for(const data of ["bad",Buffer.alloc(520000).toString("base64"),"YQ==="]) {
   assert.throws(()=>importCustomWav({accountDataDir:root,audioBase64:data,commitConfig:()=>committed++}));
 }
 const wav=makeSound("digital"),bad=Buffer.from(wav);bad.write("mp3!",0);
 assert.throws(()=>importCustomWav({accountDataDir:root,audioBase64:bad.toString("base64"),commitConfig:()=>committed++}),/Invalid/);
 assert.equal(committed,0);
});
