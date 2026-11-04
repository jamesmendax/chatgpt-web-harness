/* 灵光 render layer.
 * A pearl-white field, the iridescent presence orb (ChatGPT on this computer), small orbs that hold
 * one capability each, and an edge glow that runs around the window while ChatGPT is acting.
 * The orb shading is the concept's: three domain-warped fbm layers inside a lit sphere. */
(function (global) {
  "use strict";
  const FRAG = MAXM => `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uScale;        // device px per css px
uniform float uOn;           // 0 disconnected (pearl) … 1 connected (iridescent)
uniform float uActive;       // 0 idle … 1 a tool call is running (edge glow)
uniform float uPulse;        // 0..1 ripple after a call starts
uniform float uDim;          // modal dimming
uniform float uNight;        // 0 pearl day … 1 ink night
uniform vec4 uOrb;           // presence orb: x, y, r (css px), visibility
uniform vec4 uMood;          // warm (waiting) 0..1, alarm (error) 0..1, busy 0..1, edge boost
uniform vec4 uMini[${MAXM}];   // small orbs: x, y, r, light 0..1
uniform vec4 uMiniFx[${MAXM}]; // hue shift (turns), frost 0..1, flash 0..1, alpha
uniform float uMiniCount;

vec3 hue(float t) {
  t = fract(t);
  vec3 c1 = vec3(.26, .47, 1.), c2 = vec3(.60, .36, 1.), c3 = vec3(1., .38, .66), c4 = vec3(1., .62, .30), c5 = vec3(.22, .80, 1.);
  float s = t * 5.;
  if (s < 1.) return mix(c1, c2, smoothstep(0., 1., s));
  if (s < 2.) return mix(c2, c3, smoothstep(1., 2., s));
  if (s < 3.) return mix(c3, c4, smoothstep(2., 3., s));
  if (s < 4.) return mix(c4, c5, smoothstep(3., 4., s));
  return mix(c5, c1, smoothstep(4., 5., s));
}
vec3 hueRot(vec3 c, float a) {
  vec3 yiq = mat3(.299, .596, .211, .587, -.274, -.523, .114, -.322, .312) * c;
  float h = atan(yiq.z, yiq.y) + a * 6.2831853, ch = length(yiq.yz);
  return max(mat3(1., 1., 1., .956, -.272, -1.106, .621, -.647, 1.703) * vec3(yiq.x, ch * cos(h), ch * sin(h)), 0.);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 p, float oct) {
  float a = .5, s = 0.;
  for (int i = 0; i < 4; i++) { if (float(i) >= oct) break; s += a * noise(p); p = p * 2.03 + 7.1; a *= .5; }
  return s / (1. - pow(.5, oct)) * .9375;
}

// one orb: rgb + coverage. light 0 pearl … 1 iridescent; frost keeps it pearl (read-only)
vec4 orb(vec2 px, vec3 O, float light, float shift, float frost, float act, float pulse, float oct, vec2 mood) {
  vec2 p = (px - O.xy) / O.z;
  float r = length(p), aa = 1.5 / O.z;
  float z = sqrt(max(0., 1. - r * r));
  vec3 n = vec3(p.x, -p.y, z);
  vec2 q = n.xy * .95 + vec2(uTime * .035, -uTime * .025) + shift * 5.3;
  float f1 = fbm(q * 1.1 + vec2(0., uTime * .05), oct);
  float f2 = fbm(q * .9 + vec2(f1 * 1.4, uTime * .03) + 3.7, oct);
  float f3 = fbm(q * 1.6 + vec2(f2 * 1.2, -uTime * .04) + 9.1, oct);
  vec3 deep = vec3(.27, .45, 1.), violet = vec3(.58, .42, 1.), pink = vec3(1., .52, .76), peach = vec3(1., .78, .58);
  vec3 inner = mix(deep, violet, smoothstep(.25, .75, f1 + .25 * n.y));
  inner = mix(inner, pink, smoothstep(.42, .74, f2) * .82);
  inner = mix(inner, peach, smoothstep(.5, .84, f3) * .6 * smoothstep(-.3, .6, n.y));
  inner = mix(inner, vec3(1.), smoothstep(.58, .92, f3) * .35);
  inner = hueRot(inner, shift);
  // waiting warms the light towards amber; a failure turns it rose
  inner = mix(inner, mix(vec3(1., .74, .42), vec3(1., .9, .7), f3), mood.x * .62);
  inner = mix(inner, mix(vec3(1., .36, .46), vec3(1., .7, .72), f2), mood.y * .7);
  inner += vec3(1.) * .28 * pow(z, 3.);
  inner *= .88 + .2 * smoothstep(-.9, .7, n.y);
  // unlit glass: pearl by day, moonstone at night
  vec3 pearl = mix(mix(vec3(.86, .87, .9), vec3(.98), f2), mix(vec3(.12, .13, .17), vec3(.29, .30, .36), f2), uNight);
  float lit = light * (1. - frost);
  vec3 body = mix(pearl, inner, lit);
  body *= .86 + .18 * z;
  float fres = pow(1. - z, 2.6), ang = atan(p.y, p.x) / 6.2831853;
  body = mix(body, mix(mix(vec3(.94, .95, 1.), vec3(.5, .53, .64), uNight * (1. - lit)), hueRot(hue(ang * 2. + uTime * .08), shift), lit * .6), fres * .7);
  vec3 L = normalize(vec3(-.45, .55, .7));
  body += vec3(1.) * pow(max(dot(reflect(-L, n), vec3(0., 0., 1.)), 0.), 40.) * .75;
  body += vec3(1.) * (.12 + .25 * pulse * (1. - pulse) * 4.) * lit * act * z;
  return vec4(body, 1. - smoothstep(1. - aa, 1. + aa, r));
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale;
  vec2 size = uRes / uScale;
  vec3 col = mix(vec3(.969, .970, .978), vec3(.047, .051, .067), uNight);
  // a soft light from the upper left: daylight on pearl, moonlight on ink
  col += mix(vec3(.018), vec3(.022, .026, .05), uNight) * (1. - length((px / size - vec2(.42, .38)) * vec2(1., 1.2)));

  // edge glow: iridescent at rest, amber while waiting, rose on failure
  float d = min(min(px.x, size.x - px.x), min(px.y, size.y - px.y));
  vec2 cpos = px - size * .5;
  float ang = atan(cpos.y, cpos.x) / 6.2831853;
  vec3 g = hue(ang + uTime * .07 + .08 * sin(uTime * .6 + ang * 12.));
  g = mix(g, mix(vec3(1., .7, .38), vec3(1., .86, .55), .5 + .5 * sin(ang * 12.566 + uTime)), uMood.x * .75);
  g = mix(g, mix(vec3(1., .34, .46), vec3(1., .62, .55), .5 + .5 * sin(ang * 12.566 - uTime)), uMood.y * .8);
  float strength = max(uOn, max(uMood.x, uMood.y) * .7) * (.18 + .82 * uActive) + uMood.w * .5 + uMood.z * .25 * (.5 + .5 * sin(uTime * 3.1));
  float wide = exp(-d / 34.) * .55, thin = exp(-d / 4.) * .55;
  float breathe = .85 + .15 * sin(uTime * 2.4 + ang * 12.566);
  col = mix(col, g, clamp((wide + thin) * strength * breathe, 0., mix(.85, .7, uNight)));

  // nearest orb gets the full shading; every orb leaves its shadow and halo
  vec3 O = vec3(uOrb.xy, max(uOrb.z, 1.));
  float bestD = uOrb.w > .01 ? length(px - uOrb.xy) - uOrb.z : 1e5;
  vec4 mf = vec4(0., 0., 0., uOrb.w), mo = vec4(uOrb.xyz, uOn);
  bool mainOrb = true;
  float shadow = 0., haloA = 0., rip = 0., ripShift = 0.;
  vec3 haloC = vec3(1.);
  if (uOrb.w > .01) {
    vec2 sp = (px - (uOrb.xy + vec2(0., uOrb.z * 1.12))) / vec2(uOrb.z * .95, uOrb.z * .2);
    shadow = max(shadow, .1 * exp(-dot(sp, sp) * 1.4) * uOrb.w);
    float r = length(px - uOrb.xy) / uOrb.z;
    haloA = uOn * .22 * exp(-max(r - 1., 0.) * 5.5) * step(1., r) * uOrb.w;
    haloC = hue(uTime * .05 + .15);
    float ripple = uPulse > 0. ? exp(-pow((r - (1. + uPulse * 1.6)) * 7., 2.)) * (1. - uPulse) : 0.;
    col = mix(col, hue(uTime * .05 + .4), uOn * .35 * ripple * uOrb.w);
  }
  for (int i = 0; i < ${MAXM}; i++) {
    if (float(i) >= uMiniCount) break;
    vec4 M = uMini[i], X = uMiniFx[i];
    if (X.w < .01) continue;
    float dm = length(px - M.xy) - M.z;
    if (dm < bestD) { bestD = dm; mo = M; mf = X; mainOrb = false; }
    vec2 sp = (px - (M.xy + vec2(0., M.z * 1.18))) / vec2(M.z * .9, M.z * .26);
    shadow = max(shadow, .085 * exp(-dot(sp, sp) * 1.4) * X.w);
    float r = length(px - M.xy) / M.z;
    float lit = M.w * (1. - X.y);
    haloA = max(haloA, lit * .2 * exp(-max(r - 1., 0.) * 4.5) * step(1., r) * X.w);
    if (X.z > .001) { float rv = .4 * exp(-pow((r - (1. + (1. - X.z) * 1.5)) * 6., 2.)) * X.z * X.w; if (rv > rip) { rip = rv; ripShift = X.x; } }
  }
  if (rip > .001) col = mix(col, hueRot(hue(uTime * .05 + .4), ripShift), rip);
  // shadows read on pearl; on ink the same footprint becomes a faint pool of the orb's light
  col *= 1. - shadow * (1. - .7 * uNight);
  col += haloC * shadow * .55 * uNight * max(uOn, .25);
  col = mix(col, haloC, haloA * (1. + .7 * uNight));
  if (bestD < 2.) {
    float act = mainOrb ? uActive : 0.;
    vec4 b = orb(px, mo.xyz, mo.w, mf.x, mf.y, act, mainOrb ? uPulse : mf.z, mo.z > 40. ? 4. : 2., mainOrb ? uMood.xy : vec2(0.));
    if (!mainOrb) b.rgb += vec3(1.) * .35 * mf.z * mf.z;
    col = mix(col, b.rgb, b.w * mf.w);
  }
  col *= 1. - uDim * .08;
  col += (hash(px * 1.7 + uTime) - .5) * mix(.008, .011, uNight);
  gl_FragColor = vec4(col, 1.);
}`;

  function create(canvas) {
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    if (!gl) { document.documentElement.classList.add("no-webgl"); return null; }
    const MAXM = 24;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    const fs = sh(gl.FRAGMENT_SHADER, FRAG(MAXM));
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, "attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }")); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    const par = gl.getExtension("KHR_parallel_shader_compile");
    let ready = false, onReady = [];
    const finish = () => {
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(prog) || "link failed");
      gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "a"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      ready = true; onReady.forEach(f => f()); onReady = [];
    };
    if (par) { const poll = () => gl.getProgramParameter(prog, par.COMPLETION_STATUS_KHR) ? finish() : setTimeout(poll, 16); poll(); } else finish();
    const U = {}; const u = n => U[n] || (U[n] = gl.getUniformLocation(prog, n));
    const mini = new Float32Array(MAXM * 4), miniFx = new Float32Array(MAXM * 4);
    const t0 = performance.now();
    let frozen = null;
    return {
      max: MAXM,
      whenReady(fn) { if (ready) fn(); else onReady.push(fn); },
      freeze(t) { frozen = t; },
      draw(s) {
        if (!ready) return false;
        // quality < 1 renders fewer pixels when the GPU cannot keep up; the shader works in css px either way
        const dpr = Math.min(2, global.devicePixelRatio || 1) * Math.max(.5, Math.min(1, s.quality || 1));
        const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
        mini.fill(0); miniFx.fill(0);
        const n = Math.min(MAXM, s.minis.length);
        for (let i = 0; i < n; i++) { const m = s.minis[i], o = i * 4; mini[o] = m.x; mini[o + 1] = m.y; mini[o + 2] = m.r; mini[o + 3] = m.light; miniFx[o] = m.shift || 0; miniFx[o + 1] = m.frost || 0; miniFx[o + 2] = m.flash || 0; miniFx[o + 3] = m.alpha; }
        gl.uniform2f(u("uRes"), w, h); gl.uniform1f(u("uScale"), dpr);
        gl.uniform1f(u("uTime"), frozen != null ? frozen : (performance.now() - t0) / 1000);
        gl.uniform1f(u("uOn"), s.on); gl.uniform1f(u("uActive"), s.active); gl.uniform1f(u("uPulse"), s.pulse); gl.uniform1f(u("uDim"), s.dim); gl.uniform1f(u("uNight"), s.night || 0);
        gl.uniform4fv(u("uOrb"), s.orb); gl.uniform4fv(u("uMood"), s.mood);
        gl.uniform4fv(u("uMini"), mini); gl.uniform4fv(u("uMiniFx"), miniFx); gl.uniform1f(u("uMiniCount"), n);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return true;
      }
    };
  }
  global.AuraScene = { create };
})(window);
