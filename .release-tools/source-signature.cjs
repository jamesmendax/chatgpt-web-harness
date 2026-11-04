"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {includeProfile}=require("./build-policy.cjs");
const directories=["src","scripts","skills","public","browser-companion","bundled-plugins","desktop/src","desktop/renderer","desktop/scripts","desktop/build",".release-tools","docs","evals","third-party","bin","vendor","profiles"];
const singleFiles=["package.json","package-lock.json","tsconfig.json","desktop/package.json","desktop/package-lock.json","desktop/electron-builder.yml",".env.example","LICENSE","icon.png"];
// Generated download caches are not source; keep every release script covered.
const excludedGeneratedDirectories=new Set([".release-tools/cache"]);
function excludedPrivate(relative) {
 if (relative.split("/").some(part => part.toLowerCase() === ".env")) return true;
 return relative.startsWith("profiles/") && !includeProfile(relative.slice("profiles/".length));
}
function sourceSignature(repo){
 const files=[];
 function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);
  const rel=path.relative(repo,file).split(path.sep).join("/");
  if(excludedPrivate(rel))continue;
  if(entry.isSymbolicLink())throw new Error("Source signature refuses symlink: "+file);
  if(entry.isDirectory()){
   const relative=path.relative(repo,file).split(path.sep).join("/");
   if(!excludedGeneratedDirectories.has(relative))visit(file);
  }else if(entry.isFile())files.push(file);
 }}
 for(const rel of directories){const dir=path.join(repo,rel);if(fs.existsSync(dir))visit(dir);}
 for(const rel of singleFiles){const file=path.join(repo,rel);if(fs.existsSync(file))files.push(file);}
 const rows=files.sort().map(file=>({path:path.relative(repo,file).split(path.sep).join("/"),sha256:crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}));
 return {sha256:crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex"),files:rows};
}
function assertSourceManifest(signature, manifest) {
 const actual=new Map(manifest.map(row=>[row.path,row.sha256]));
 for(const row of signature.files){
  if(!actual.has(row.path))throw new Error("Source archive omitted participating input: "+row.path);
  if(actual.get(row.path)!==row.sha256)throw new Error("Source archive changed participating input: "+row.path);
 }
}
module.exports={sourceSignature,assertSourceManifest};
