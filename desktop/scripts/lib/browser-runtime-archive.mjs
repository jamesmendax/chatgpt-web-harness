import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require=createRequire(import.meta.url);
export const ARCHIVE_NAME='browser-use.runtime.zip';
export const ARCHIVE_METADATA_NAME='browser-use.archive.json';
const hash=file=>{
  const digest=createHash('sha256'),buffer=Buffer.allocUnsafe(4*1024*1024),descriptor=fs.openSync(file,'r');
  try{let bytes;while((bytes=fs.readSync(descriptor,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,bytes));}
  finally{fs.closeSync(descriptor);}
  return digest.digest('hex');
};
export function browserRuntimeInventory(root){
  let ancestor=path.resolve(root);
  while(true){if(fs.lstatSync(ancestor).isSymbolicLink())throw Error('Browser runtime ancestry must not contain a link');const parent=path.dirname(ancestor);if(parent===ancestor)break;ancestor=parent;}
  const files=[],seen=new Set();
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name),relative=path.relative(root,full).split(path.sep).join('/');
    if(entry.isSymbolicLink()||fs.lstatSync(full).isSymbolicLink())throw Error('Browser runtime contains a link: '+relative);
    if(/[\r\n\0]/.test(relative)||relative.split('/').some(p=>['.git','.codex','.cache','__pycache__','user data','crashpad','browsermetrics'].includes(p.toLowerCase()))||/(?:^|\/)\.env(?:\.|$)|\.(?:log|pyc|pyo)$|(?:^|\/)singleton(?:lock|cookie|socket)$/i.test(relative))throw Error('Browser runtime contains cache or private input: '+relative);
    if(entry.isDirectory()){walk(full);continue;}
    if(!entry.isFile())throw Error('Browser runtime contains unsupported file: '+relative);
    const key=relative.toLowerCase();if(seen.has(key))throw Error('Browser runtime contains duplicate path: '+relative);seen.add(key);
    files.push({path:relative,bytes:fs.statSync(full).size,sha256:hash(full)});
  }}walk(root);return files.sort((a,b)=>a.path.localeCompare(b.path));
}
export function resolveLocal7zip(desktopRoot){
  const candidates=[process.env.ELECTRON_BUILDER_7ZIP_PATH];
  try{candidates.push(require('7zip-bin').path7za);}catch{}
  const executable=candidates.find(file=>file&&fs.existsSync(file)&&fs.lstatSync(file).isFile());
  if(!executable&&process.platform!=='win32')throw Error('An existing local 7zip executable is required; set ELECTRON_BUILDER_7ZIP_PATH. Nothing is downloaded.');
  return executable;
}
export function archiveBrowserRuntime(staging,{sevenZip,desktopRoot=path.resolve(staging,'../..')}={}){
  staging=path.resolve(staging);
  const vendor=path.join(staging,'vendor'),root=path.join(vendor,'browser-use');
  const files=browserRuntimeInventory(root),total=files.reduce((sum,file)=>sum+file.bytes,0);
  if(!files.length||files.length>20000||!Number.isSafeInteger(total)||total>1024**3)throw Error('Browser runtime archive expanded size/count exceeds runtime limits');
  const archive=path.join(vendor,ARCHIVE_NAME),metadata=path.join(vendor,ARCHIVE_METADATA_NAME),list=path.join(vendor,'.browser-use-archive-files.txt');
  if(fs.existsSync(archive)||fs.existsSync(metadata))throw Error('Browser runtime archive output already exists');
  fs.writeFileSync(list,files.map(file=>file.path).join('\n')+'\n');
  const executable=sevenZip||resolveLocal7zip(desktopRoot);
  try{
   if(executable){
    const result=spawnSync(executable,['a','-tzip','-mx=1','-mmt=on','-spd','-scsUTF-8',archive,'@'+list],{cwd:root,windowsHide:true,encoding:'utf8',maxBuffer:1024*1024});
    if(result.status!==0)throw Error('Browser runtime ZIP creation failed: '+String(result.stderr||result.stdout).slice(-1200));
    const test=spawnSync(executable,['t',archive],{windowsHide:true,encoding:'utf8',maxBuffer:1024*1024});if(test.status!==0)throw Error('Browser runtime ZIP integrity check failed');
   }else{
    // Clean Windows builds need no downloaded archiver or machine-specific cache.
    // .NET writes only inventory files, so ZIP roots and directory entries match 7za.
    const quote=value=>"'"+value.replaceAll("'","''")+"'";
    const script=["$ErrorActionPreference='Stop'","Add-Type -AssemblyName System.IO.Compression","Add-Type -AssemblyName System.IO.Compression.FileSystem",`$root=${quote(root)}`,`$zip=[IO.Compression.ZipFile]::Open(${quote(archive)},[IO.Compression.ZipArchiveMode]::Create)`,"$fixedTime=[DateTimeOffset]::new(2000,1,1,0,0,0,[TimeSpan]::Zero)","try {",`foreach ($relative in (Get-Content -LiteralPath ${quote(list)} -Encoding UTF8)) { $entry=$zip.CreateEntry($relative,[IO.Compression.CompressionLevel]::Fastest); $entry.LastWriteTime=$fixedTime; $entry.ExternalAttributes=0; $inputFile=[IO.File]::OpenRead([IO.Path]::Combine($root,$relative)); try { $outputFile=$entry.Open(); try { $inputFile.CopyTo($outputFile,65536) } finally { $outputFile.Dispose() } } finally { $inputFile.Dispose() } }`,"} finally { $zip.Dispose() }"].join('\n');
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',maxBuffer:1024*1024});
    if(result.status!==0)throw Error('Browser runtime ZIP creation failed using Windows .NET: '+String(result.stderr).slice(-1200));
   }
    if(fs.statSync(archive).size>512*1024**2)throw Error('Browser runtime archive exceeds 512 MiB runtime limit');
    const manifest={schema_version:1,archive:ARCHIVE_NAME,sha256:hash(archive),bytes:fs.statSync(archive).size,total_bytes:total,file_count:files.length,files};
    fs.writeFileSync(metadata,JSON.stringify(manifest,null,2)+'\n');
    // Only the disposable staging tree is removed, after archive verification.
    fs.rmSync(root,{recursive:true});return manifest;
  }catch(error){fs.rmSync(archive,{force:true});fs.rmSync(metadata,{force:true});throw error;}
  finally{fs.rmSync(list,{force:true});}
}
