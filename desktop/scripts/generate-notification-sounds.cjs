"use strict";
// Original, deterministic synthetic sounds. Never samples music or recordings.
// Matches the native Windows SoundPlayer PCM format already used by Web Harness.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const RATE=44100;
const STYLES=Object.freeze({
  waterdrop:{file:"web-harness-waterdrop.wav",name:"水滴双音",duration:.74},
  xylophone:{file:"web-harness-xylophone.wav",name:"木琴轻敲",duration:.94},
  bells:{file:"web-harness-bells.wav",name:"清亮风铃",duration:1.38},
  digital:{file:"web-harness-digital.wav",name:"电子短讯",duration:.63},
});
const tone=(hz,t,age,decay,attack=.003)=>age<0?0:
  Math.sin(2*Math.PI*hz*age)*Math.min(1,age/attack)*Math.exp(-age/decay);
function makeSound(kind) {
  const style=STYLES[kind];if(!style)throw Error("Unknown original sound");
  const length=Math.round(RATE*style.duration),samples=new Float64Array(length);
  let peak=0;
  for(let i=0;i<length;i++){
    const t=i/RATE;
    let s=0;
    if(kind==="waterdrop"){
      const drop=(start,hz)=>{const a=t-start;if(a<0)return 0;
        const bend=hz*(a-.11*a*a);
        const env=Math.min(1,a/.004)*Math.exp(-a/.105);
        return Math.sin(2*Math.PI*bend)*env+.14*tone(hz*1.92,t,a,.044);
      };
      s=.9*drop(.028,1020)+.78*drop(.265,1375);
    }else if(kind==="xylophone"){
      for(const [start,hz,amp] of [[.028,523.25,1],[.285,659.25,.73]]) {
        const a=t-start;if(a<0)continue;
        s+=amp*(tone(hz,t,a,.22)+.36*tone(hz*3,t,a,.09)+.12*tone(hz*6.2,t,a,.035));
      }
    }else if(kind==="bells"){
      for(const [start,hz] of [[.025,880],[.19,1174.66],[.395,988]]) {
        const a=t-start;if(a<0)continue;
        s+=.72*(tone(hz,t,a,.39)+.25*tone(hz*2.414,t,a,.28)+.12*tone(hz*3.71,t,a,.15));
      }
    }else if(kind==="digital"){
      for(const [start,frequency] of [[.025,960],[.172,1280],[.312,960]]) {
        const a=t-start;if(a<0)continue;
        s+=.7*(tone(frequency,t,a,.065,.002)+.18*tone(frequency*2,t,a,.04));
      }
    }
    s*=Math.min(1,(length-1-i)/(RATE*.028));
    samples[i]=s;
    peak=Math.max(peak,Math.abs(s));
  }
  if(!peak)throw Error("Empty sound synthesis");
  const wav=Buffer.alloc(44+length*2);
  wav.write("RIFF",0);wav.writeUInt32LE(wav.length-8,4);wav.write("WAVEfmt ",8);
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(RATE,24);wav.writeUInt32LE(RATE*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);
  wav.write("data",36);wav.writeUInt32LE(length*2,40);
  for(let i=0;i<length;i++)wav.writeInt16LE(Math.round(samples[i]/peak*.53*32767),44+i*2);
  return wav;
}
if(require.main===module) {
  const root=path.join(__dirname,"..","src","assets");
  fs.mkdirSync(root,{recursive:true});
  const summaries=[];
  for(const [id,item] of Object.entries(STYLES)) {
    const bytes=makeSound(id),target=path.join(root,item.file);
    if(fs.existsSync(target)) {
      if(!fs.readFileSync(target).equals(bytes))throw Error("Asset collision: "+item.file);
    }else fs.writeFileSync(target,bytes,{flag:"wx"});
    summaries.push({id,bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")});
  }
  console.log(JSON.stringify(summaries));
}
module.exports={makeSound,STYLES,RATE};
