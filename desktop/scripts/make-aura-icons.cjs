"use strict";
// Derive the desktop identity from Aura's actual orb shader. The UI scene is
// read-only; only this icon composition has transparent pixels and no page.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const desktop = path.resolve(__dirname, "..");
const repo = path.resolve(desktop, "..");
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function icoFromPngs(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map(frame => frame.png)]);
}

async function generate(options = {}) {
  const scenePath = path.join(desktop, "renderer/v3/aura/scene.js");
  const scene = fs.readFileSync(scenePath, "utf8");
  const start = scene.indexOf("  const FRAG =");
  const end = scene.indexOf("  function create(");
  if (start < 0 || end < start) throw new Error("Aura shader declaration was not found; refusing a mismatched icon");
  const fragment = vm.runInNewContext(scene.slice(start, end) + "\nFRAG(1)", {}, { timeout: 1000 });
  const helpers = fragment.slice(0, fragment.indexOf("void main()"));
  const iconFragment = helpers.replace("aa = 1.5 / O.z", "aa = .55 / O.z") + `
void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale;
  vec2 size = uRes / uScale;
  float side = min(size.x, size.y);
  vec3 O = vec3(size * vec2(.5, .466), side * .402);
  float r = length(px - O.xy) / O.z;
  vec4 body = orb(px, O, .86, 0., 0., 0., 0., side < 49. ? 2. : 4., vec2(0.));
  // A restrained rim keeps the soft pearl legible on light and dark taskbars.
  float edge = pow(clamp(r, 0., 1.), 12.);
  vec3 rim = mix(vec3(.47, .43, .74), hue(atan(px.y-O.y, px.x-O.x)/6.2831853+.34), .34);
  body.rgb = mix(body.rgb, rim, edge * .20);
  vec2 sp = (px - (O.xy + vec2(0., O.z * 1.10))) / (O.z * vec2(.79, .14));
  float shadow = .13 * exp(-dot(sp, sp) * 1.7);
  float halo = .11 * exp(-pow(max(r - 1., 0.) * 15., 2.)) * step(1., r);
  float underAlpha = max(shadow, halo);
  vec3 underColor = mix(vec3(.36, .37, .49), vec3(.64, .55, .90), halo / max(.0001, shadow + halo));
  float alpha = body.a + underAlpha * (1. - body.a);
  vec3 color = (body.rgb * body.a + underColor * underAlpha * (1. - body.a)) / max(alpha, .00001);
  gl_FragColor = vec4(color, alpha);
}`;
  const { chromium } = require(path.join(repo, "node_modules/playwright-core"));
  const executablePath = options.browser || path.join(repo, "vendor/browser-use/chrome/chrome-win64/chrome.exe");
  if (!fs.existsSync(executablePath)) throw new Error("A local verified Chromium runtime is required; this command does not download one");
  const tmp = path.join(repo, ".validation", "aura-icons", "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const originalTemp = process.env.TEMP, originalTmp = process.env.TMP;
  process.env.TEMP = tmp; process.env.TMP = tmp;
  let browser;
  const results = [];
  try {
    browser = await chromium.launch({ executablePath, headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body><canvas id="icon"></canvas></body></html>');
    const rendered = await page.evaluate(({ fragment, sizes }) => {
      const canvas = document.querySelector("canvas");
      const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
      if (!gl) throw new Error("WebGL is unavailable");
      function compile(type, source) {
        const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
      }
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}"));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
      const attribute = gl.getAttribLocation(program, "a"); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
      const u = name => gl.getUniformLocation(program, name);
      const rendered = [];
      for (const size of sizes) {
        const scale = size < 128 ? 4 : 2;
        canvas.width = canvas.height = size * scale; gl.viewport(0, 0, canvas.width, canvas.height);
        gl.uniform2f(u("uRes"), canvas.width, canvas.height); gl.uniform1f(u("uScale"), scale); gl.uniform1f(u("uTime"), 2.8);
        gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.finish();
        const output = document.createElement("canvas"); output.width = output.height = size;
        const ctx = output.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(canvas, 0, 0, size, size);
        rendered.push({ size, png: output.toDataURL("image/png").split(",")[1] });
      }
      return rendered;
    }, { fragment: iconFragment, sizes: [...sizes, 512, 1024] });
    const build = path.join(desktop, "build"), assets = path.join(build, "aura-icons");
    fs.mkdirSync(assets, { recursive: true });
    const frames = [];
    for (const frame of rendered) {
      const png = Buffer.from(frame.png, "base64");
      const file = path.join(assets, `${frame.size}.png`);
      fs.writeFileSync(file, png); results.push({ file: path.relative(repo, file).replaceAll("\\", "/"), width: frame.size, height: frame.size, sha256: sha(png) });
      if (sizes.includes(frame.size)) frames.push({ size: frame.size, png });
      if (frame.size === 512) { fs.writeFileSync(path.join(build, "icon.png"), png); fs.writeFileSync(path.join(repo, "icon.png"), png); }
    }
    const ico = icoFromPngs(frames); fs.writeFileSync(path.join(build, "icon.ico"), ico);
    const provenance = { schemaVersion: 1, source: "desktop/renderer/v3/aura/scene.js", sourceSha256: sha(Buffer.from(scene)), method: "Aura orb shader, fixed time 2.8, transparent icon composition and pixel-size exports", palette: "Pearl, lavender, rose, peach and cyan from the existing Aura shader", legacyGlyphUsed: false, transparent: true, icoSizes: sizes, icoSha256: sha(ico), files: results };
    fs.writeFileSync(path.join(build, "aura-icon-provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
    console.log(JSON.stringify({ generated: results.length + 3, icon: path.join(build, "icon.png"), ico: path.join(build, "icon.ico"), sizes }));
    return provenance;
  } finally {
    if (browser) await browser.close();
    if (originalTemp === undefined) delete process.env.TEMP; else process.env.TEMP = originalTemp;
    if (originalTmp === undefined) delete process.env.TMP; else process.env.TMP = originalTmp;
  }
}
module.exports = { generate, icoFromPngs };
if (require.main === module) generate().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
