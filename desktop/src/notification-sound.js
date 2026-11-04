"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");

// Read the bundled WAV with Electron's fs (including app.asar), then stream bytes
// to Windows. No external asset path, shell interpolation, registry setting,
// default beep, hidden browser, or user-profile extraction is required.
const WAV_PATH = path.join(__dirname, "assets", "web-harness-chime.wav");
const SOUND_CHOICES = Object.freeze([
  Object.freeze({ id: "glass", name: "琉璃三连", file: "web-harness-chime.wav" }),
  Object.freeze({ id: "waterdrop", name: "水滴双音", file: "web-harness-waterdrop.wav" }),
  Object.freeze({ id: "xylophone", name: "木琴轻敲", file: "web-harness-xylophone.wav" }),
  Object.freeze({ id: "bells", name: "清亮风铃", file: "web-harness-bells.wav" }),
  Object.freeze({ id: "digital", name: "电子短讯", file: "web-harness-digital.wav" }),
]);
const SOUND_IDS = new Set([...SOUND_CHOICES.map(x=>x.id),"custom"]);
const PLAY_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$inputStream=$null; $memory=$null; $player=$null",
  "try {",
  " $inputStream=[Console]::OpenStandardInput()",
  " $memory=New-Object System.IO.MemoryStream",
  " $inputStream.CopyTo($memory)",
  " $memory.Position=0",
  " $player=New-Object System.Media.SoundPlayer",
  " $player.Stream=$memory",
  " $player.Load()",
  " $player.PlaySync()",
  " [Console]::Out.WriteLine('WH_CHIME_PLAYED')",
  "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  "finally { if($player){$player.Dispose()}; if($memory){$memory.Dispose()}; if($inputStream){$inputStream.Dispose()} }",
].join("\n");

function validateWav(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44 || bytes.length > 512 * 1024 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" ||
      bytes.readUInt32LE(4) + 8 !== bytes.length || bytes.readUInt16LE(20) !== 1 ||
      bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 44100 ||
      bytes.readUInt16LE(34) !== 16 || bytes.toString("ascii", 36, 40) !== "data" ||
      bytes.readUInt32LE(40) + 44 !== bytes.length ||
      bytes.readUInt32LE(40) < 44100 * 2 * 0.3 ||
      bytes.readUInt32LE(40) > 44100 * 2 * 5) throw new Error("Invalid notification WAV: expected 44.1kHz mono PCM 16-bit, 0.3–5s");
  return bytes;
}
function applyGain(bytes,volume=100) {
  if(!Number.isInteger(volume)||volume<0||volume>100)throw Error("通知音量必须为 0–100");
  if(volume===100)return bytes;
  const out=Buffer.from(bytes);
  for(let i=44;i<out.length;i+=2)out.writeInt16LE(Math.round(out.readInt16LE(i)*volume/100),i);
  return out;
}

function createNotificationSound({ platform = process.platform, execute = execFile,
  readFile = fs.readFile, assetPath = WAV_PATH, getSelection = () => ({id:"glass",volume:100}),
  executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
} = {}) {
  const pendingByAccount=new Map(),children=new Set();
  let disposed = false;
  function play(accountId="default", overrideId=null) {
    if (disposed || platform !== "win32") return Promise.resolve(false);
    // A simultaneous batch of due conversations shares one chime, not a sound storm.
    if(pendingByAccount.has(accountId))return pendingByAccount.get(accountId);
    const setting=getSelection(accountId)||{},id=overrideId||setting.id||"glass";
    if(!SOUND_IDS.has(id))return Promise.reject(Error("未知通知提示音"));
    const filename=id==="custom" ? setting.customPath :
      id==="glass" ? assetPath :
      path.join(__dirname,"assets",SOUND_CHOICES.find(x=>x.id===id).file);
    if (typeof filename!=="string" || !path.isAbsolute(filename))
      return Promise.reject(Error("自定义通知音频尚未导入"));
    let pending=Promise.resolve().then(() => readFile(filename)).then(bytes => {
      if (disposed) return false;
      validateWav(bytes);
      const audio=applyGain(bytes,setting.volume===undefined?100:setting.volume);
      if(setting.volume===0)return false;
      return new Promise((resolve, reject) => {
        let settled = false, owned=null;
        const finish = (error, stdout = "") => {
          if (settled) return;
          settled = true; if(owned)children.delete(owned);
          if (error) reject(error);
          else if (!String(stdout).includes("WH_CHIME_PLAYED")) reject(new Error("Native sound completion was not acknowledged"));
          else resolve(true);
        };
        try {
          owned = execute(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PLAY_SCRIPT, "utf16le").toString("base64")],
            { windowsHide: true, timeout: 8000, maxBuffer: 16384, encoding: "utf8" }, finish);
          if (owned) children.add(owned);
          if (!owned?.stdin) { owned?.kill(); finish(new Error("Native sound input pipe is unavailable")); return; }
          owned.stdin.once("error", error => { try { owned.kill(); } catch {} finish(error); });
          owned.stdin.end(audio);
        } catch (error) { try { owned?.kill(); } catch {} finish(error); }
      });
    }).finally(() => { if(pendingByAccount.get(accountId)===pending)pendingByAccount.delete(accountId); });
    pendingByAccount.set(accountId,pending);
    return pending;
  }
  function dispose() {
    disposed = true;
    for(const child of children) { try { child.kill(); } catch {} }
    children.clear();
  }
  return { play, dispose };
}
module.exports = { createNotificationSound, validateWav, applyGain, SOUND_CHOICES, SOUND_IDS, WAV_PATH, PLAY_SCRIPT };
