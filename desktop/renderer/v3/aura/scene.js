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
uniform float uCurtainTime; // independent light-curtain clock
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
uniform vec4 uEffects;       // edge, halo, ripple/feedback, material octave budget
uniform float uUltra;        // ultra-only choreography; high stays original
uniform vec4 uMotion;        // energy, gathering progress, resolving progress, outcome
uniform vec4 uOrbit;         // continuous phase, bounded concurrency, material time, enabled

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

// Selected R3 original: an opaque pigment sphere, not a glass shell.
// Choreography is separate from the material. No texture/history allocations.
vec3 solidNormal(vec2 p) { return normalize(vec3(p.x,-p.y,sqrt(max(.00001,1.-dot(p,p))))); }
vec3 solidFinish(vec3 pigment, vec3 N, float satin, float life) {
  vec3 V=vec3(0.,0.,1.);
  vec3 key=normalize(vec3(-.48,.68,.78)), fill=normalize(vec3(.67,-.30,.66));
  float ndl=max(0.,dot(N,key)), ndl2=max(0.,dot(N,fill));
  float wrap=smoothstep(-.34,.96,dot(N,key));
  float falloff=.38+.57*wrap+.16*ndl2;
  vec3 C=pigment*falloff*(.86+.14*N.z);
  C+=pigment*vec3(.09,.12,.19)*pow(N.z,2.3);
  C+=vec3(.11,.18,.32)*pow(ndl2,5.)*(.12+.10*satin);
  vec3 R=reflect(-V,N);
  float pinpoint=pow(max(dot(R,key),0.),mix(110.,72.,satin));
  float shoulder=pow(max(dot(R,key),0.),mix(10.,5.5,satin));
  float satinSweep=pow(max(dot(R,normalize(vec3(-.72,.42,.66))),0.),18.);
  C+=vec3(.88,.94,1.)*(pinpoint*(.52-.12*satin)+shoulder*(.10+.045*satin));
  C+=mix(vec3(.38,.57,1.),vec3(.83,.67,.95),satin)*satinSweep*.075;
  float softbox=exp(-pow((R.x+.48)*2.8,2.)-pow((R.y-.65)*5.,2.));
  C+=vec3(.79,.86,1.)*softbox*(.04+.10*satin);
  float graze=pow(1.-N.z,3.6);
  vec3 edgeColor=mix(vec3(.17,.49,.89),vec3(.64,.40,.87),smoothstep(-.8,.8,N.y));
  C=mix(C,edgeColor,graze*(.22+.38*ndl+.22*ndl2)*.32);
  C+=pigment*pow(max(0.,dot(N,normalize(vec3(.65,.4,-.5)))),3.)*.10*satin;
  C=C/(vec3(1.)+max(C-vec3(.72),vec3(0.))*.38);
  return clamp(C,0.,1.);
}
vec3 selectedOriginal(vec2 p) {
  vec3 N=solidNormal(p);
  vec2 q=N.xy*.95+vec2(uTime*.035,-uTime*.025);
  float f=fbm(q*1.1+vec2(0.,uTime*.05),4.);
  float g=fbm(q*.9+vec2(f*1.4,uTime*.03)+3.7,4.);
  float h=fbm(q*1.6+vec2(g*1.2,-uTime*.04)+9.1,4.);
  vec3 C=mix(vec3(.24,.43,.98),vec3(.61,.39,.98),smoothstep(.23,.74,f+.20*N.y));
  C=mix(C,vec3(.97,.49,.75),smoothstep(.39,.73,g)*.79);
  C=mix(C,vec3(.98,.76,.59),smoothstep(.50,.84,h)*.43*smoothstep(-.3,.7,N.y));
  C=mix(C,vec3(.35,.64,1.),exp(-pow((f-g+.11)*3.2,2.))*.18);
  C*=.94+.11*smoothstep(.25,.8,h);
  C=mix(C,vec3(.72,.56,.98),exp(-pow((g-h-.08)*10.,2.))*.12);
  C+=vec3(.10,.15,.22)*pow(N.z,2.8);
  return solidFinish(C,N,.18,.4);
}
vec4 animatedOriginal(vec2 px, vec3 O, float light, vec2 mood) {
  float sat=clamp(light,0.,1.);
  // Keep High's unconnected clear-outline state; no permanent color fill.
  if (sat < .001) return orb(px,O,0.,0.,0.,0.,0.,4.,vec2(0.));
  vec2 p=(px-O.xy)/O.z;
  float r=length(p), aa=1.5/O.z;
  vec3 N=solidNormal(p);
  // A coherent rotation of the surface normal, never a moving sticker.
  float tilt=.018*uMotion.x*sin(uOrbit.x*.7);
  mat2 rot=mat2(cos(tilt),-sin(tilt),sin(tilt),cos(tilt));
  vec3 C=selectedOriginal(rot*p);
  // Only connection transitions need both surfaces; normal work retains
  // the selected solid material without new textures or render passes.
  if (sat < .999) {
    vec4 resting=orb(px,O,0.,0.,0.,0.,0.,4.,vec2(0.));
    C=mix(resting.rgb,C,smoothstep(0.,1.,sat));
  }
  C=mix(C,vec3(.80,.49,.28),mood.x*.20);
  float errorEnvelope=sin(3.14159265*uMotion.z)*(1.-uMotion.z);
  C=mix(C,vec3(.75,.26,.40),max(mood.y*.30,step(uMotion.w,-.5)*errorEnvelope*.38));
  // One directional sheen crosses the spherical surface during execution.
  vec3 driftKey=normalize(vec3(.48*cos(uOrbit.x),.55*sin(uOrbit.x),.84));
  float sheen=pow(max(dot(reflect(vec3(0.,0.,-1.),N),driftKey),0.),18.);
  C+=mix(vec3(.20,.43,.92),vec3(.62,.33,.82),.5+.5*sin(uOrbit.x))
      *sheen*.22*uMotion.x;
  float completion=sin(3.14159265*uMotion.z)*(1.-uMotion.z)*step(.75,uMotion.w);
  float sweep=exp(-pow((p.x*.56-p.y*.83-(uMotion.z*2.6-1.3))*5.0,2.));
  C+=vec3(.40,.72,.88)*sweep*completion*.27*N.z;
  // Preserve a visible work-state lift, not just a dim orbit ring.
  float work=max(uActive,uMotion.x);
  float launch=4.*uPulse*(1.-uPulse);
  C+=C*(.12+.22*launch)*work*pow(N.z,1.5)*sat;
  return vec4(clamp(C,0.,1.),1.-smoothstep(1.-aa,1.+aa,r));
}
// Analytic light paths close to the orb: fixed work, no particles or trails.
vec3 ultraLocalLight(vec3 background, vec2 px, vec3 O) {
  vec2 q=(px-O.xy)/O.z;
  float r=length(q);
  if (r<1.001 || r>1.75) return background;
  float a=atan(q.y,q.x), phase=uOrbit.x;
  float energy=uMotion.x, enter=uMotion.y, leave=uMotion.z;
  float gather=sin(3.14159265*enter)*(1.-enter);
  float finish=sin(3.14159265*leave)*(1.-leave);
  vec3 cyan=vec3(.26,.68,.97), violet=vec3(.67,.42,.94), rose=vec3(.91,.39,.63);
  float head=pow(.5+.5*cos(a-phase),8.);
  float tail=pow(.5+.5*cos(a-phase+.54),3.);
  float arc=exp(-pow((r-(1.075+.022*sin(a*2.-phase)))*38.,2.));
  float echo=exp(-pow((r-1.13)*32.,2.))*pow(.5+.5*cos(a+phase*.62-2.4),11.);
  vec3 tint=mix(cyan,violet,.5+.5*sin(a));
  float level=energy*(arc*(head*.46+tail*.065)+echo*(.12+.16*uOrbit.y));
  float approach=exp(-pow((r-(1.43-.36*smoothstep(0.,1.,enter)))*16.,2.));
  level+=approach*gather*(.24+.20*pow(.5+.5*cos(a+1.3),3.));
  float departure=exp(-pow((r-(1.04+.56*leave))*20.,2.));
  float success=step(.75,uMotion.w);
  level+=departure*finish*.40*success*(.20+.80*pow(.5+.5*cos(a-.65),2.));
  float fault=step(uMotion.w,-.5)*finish;
  level+=fault*.22*exp(-pow((r-1.07)*10.,2.))*pow(.5+.5*sin(a),2.);
  tint=mix(tint,rose,clamp(fault*3.,0.,1.));
  float mist=exp(-pow((r-1.04)*5.,2.))*(.014+.034*energy);
  return mix(background,tint,clamp(level+mist,0.,.62)*uOrb.w*uOn);
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale;
  vec2 size = uRes / uScale;
  vec3 col = mix(vec3(.969, .970, .978), vec3(.047, .051, .067), uNight);
  // a soft light from the upper left: daylight on pearl, moonlight on ink
  col += mix(vec3(.018), vec3(.022, .026, .05), uNight) * (1. - length((px / size - vec2(.42, .38)) * vec2(1., 1.2)));

  // edge glow: iridescent at rest, amber while waiting, rose on failure
  float d = min(min(px.x, size.x - px.x), min(px.y, size.y - px.y));
  // Outside 256 CSS px, the exponential edge contribution is invisible.
  // Skip atan/sin/exp in this interior without changing the animated glow.
  if (uEffects.x > .001 && d < 256.) {
    vec2 cpos = px - size * .5;
    float ang = atan(cpos.y, cpos.x) / 6.2831853;
    vec3 g = hue(ang + uCurtainTime * .07 + .08 * sin(uCurtainTime * .6 + ang * 12.));
    g = mix(g, mix(vec3(1., .7, .38), vec3(1., .86, .55), .5 + .5 * sin(ang * 12.566 + uCurtainTime)), uMood.x * .75);
    g = mix(g, mix(vec3(1., .34, .46), vec3(1., .62, .55), .5 + .5 * sin(ang * 12.566 - uCurtainTime)), uMood.y * .8);
    float strength = max(uOn, max(uMood.x, uMood.y) * .7) * (.18 + .82 * uActive) + uMood.w * .5 + uMood.z * .25 * (.5 + .5 * sin(uCurtainTime * 3.1));
    // Ultra inherits the COMPLETE High curtain. Event response only adds
    // energy; it never suppresses the established idle/work baseline.
    if (uUltra > .5 && uOrbit.w > .5) {
      float gather=sin(3.14159265*uMotion.y)*(1.-uMotion.y);
      strength *= 1. + .14*uMotion.x + .12*gather;
    }
    float wide = exp(-d / mix(6., 34., uEffects.x)) * .55, thin = exp(-d / 4.) * .55;
    float breathe = .85 + .15 * sin(uCurtainTime * 2.4 + ang * 12.566);
    col = mix(col, g, clamp((wide + thin) * strength * breathe * uEffects.x, 0., mix(.85, .7, uNight)));
  }

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
    // Keep the original outward call ripple in BOTH High and Ultra.
    col = mix(col, hue(uTime * .05 + .4), uOn * .35 * ripple * uOrb.w * uEffects.z);
  }
  for (int i = 0; i < ${MAXM}; i++) {
    if (float(i) >= uMiniCount) break;
    vec4 M = uMini[i], X = uMiniFx[i];
    if (X.w < .01) continue;
    // Mini-orb halos, shadows and ripples are below 8-bit visibility
    // beyond 4.75 radii; avoid costly work for unrelated pixels.
    vec2 delta = px - M.xy;
    float extent = M.z * 4.75;
    if (abs(delta.x) > extent || abs(delta.y) > extent) continue;
    float dm = length(delta) - M.z;
    if (dm < bestD) { bestD = dm; mo = M; mf = X; mainOrb = false; }
    vec2 sp = (delta - vec2(0., M.z * 1.18)) / vec2(M.z * .9, M.z * .26);
    shadow = max(shadow, .085 * exp(-dot(sp, sp) * 1.4) * X.w);
    float r = length(delta) / M.z;
    float lit = M.w * (1. - X.y);
    haloA = max(haloA, lit * .2 * exp(-max(r - 1., 0.) * 4.5) * step(1., r) * X.w);
    if (uEffects.z > .001 && X.z > .001) { float rv = .4 * exp(-pow((r - (1. + (1. - X.z) * 1.5)) * 6., 2.)) * X.z * X.w * uEffects.z; if (rv > rip) { rip = rv; ripShift = X.x; } }
  }
  if (rip > .001) col = mix(col, hueRot(hue(uTime * .05 + .4), ripShift), rip);
  // shadows read on pearl; on ink the same footprint becomes a faint pool of the orb's light
  col *= 1. - shadow * (1. - .7 * uNight);
  col += haloC * shadow * .55 * uNight * max(uOn, .25);
  col = mix(col, haloC, haloA * (1. + .7 * uNight) * uEffects.y);
  if (uUltra > .5 && uOrb.w > .01 && uOrbit.w > .5) col = ultraLocalLight(col,px,O);
  if (bestD < 2.) {
    float act = mainOrb ? uActive * uEffects.z : 0.;
    vec4 b;
    if (uUltra > .5 && mainOrb) {
      b = animatedOriginal(px, mo.xyz, mo.w, uMood.xy);
    } else {
      b = orb(px, mo.xyz, mo.w, mf.x, mf.y, act, (mainOrb ? uPulse : mf.z) * uEffects.z, min(mo.z > 40. ? 4. : 2., uEffects.w), mainOrb ? uMood.xy : vec2(0.));
    }
    if (!mainOrb) b.rgb += vec3(1.) * .35 * mf.z * mf.z * uEffects.z;
    col = mix(col, b.rgb, b.w * mf.w);
  }
  col *= 1. - uDim * .08;
  col += (hash(px * 1.7 + uTime) - .5) * mix(.008, .011, uNight);
  gl_FragColor = vec4(col, 1.);
}`;

  function create(canvas) {
    const gl = canvas.getContext("webgl", { antialias: false, alpha: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) { document.documentElement.classList.add("no-webgl"); return null; }
    const MAXM = 24, MAX_FRAMEBUFFER_PIXELS = 8294400;
    const pendingReady = new Set(), uniforms = new Map(), shaders = [];
    const mini = new Float32Array(MAXM * 4), miniFx = new Float32Array(MAXM * 4);
    // Tier changes reuse this uniform buffer and the existing GL program.
    const effects = new Float32Array([1, 1, 1, 4]);
    const quietMotion = new Float32Array([0, 1, 1, 0]);
    const quietOrbit = new Float32Array([0, 0, 9, 0]);
    let program = null, buffer = null, ready = false, disposed = false, compileTimer = 0;
    let observer = null, frozen = null, cssWidth = 1, cssHeight = 1, sizeDirty = true;
    const started = performance.now();
    // Shader time is float32: after ~3 days its step exceeds a frame. The
    // owner restarts this base where the jump is invisible (see rebase).
    let clockBase = started;
    let draws = 0, resizes = 0;
    const attempt = fn => { try { fn(); } catch (_) {} };
    const onResize = () => { sizeDirty = true; };
    const onLost = event => {
      if (disposed) return;
      event.preventDefault?.();
      dispose();
      // A lost context is usually transient (GPU process restart, driver
      // reset, sleep/resume); the owner decides whether to rebuild one.
      const guard = global.AuraMemoryGuard;
      if (guard?.contextLost) guard.contextLost(); else guard?.disable();
    };
    function dispose() {
      if (disposed) return;
      disposed = true; ready = false;
      if (compileTimer) clearTimeout(compileTimer);
      compileTimer = 0; pendingReady.clear();
      observer?.disconnect(); observer = null;
      global.removeEventListener?.("resize", onResize);
      // Remove BEFORE loseContext: delayed loss on an obsolete canvas must
      // never turn off a newly created scene after rapid static/dynamic toggles.
      canvas.removeEventListener?.("webglcontextlost", onLost);
      if (buffer) attempt(() => gl.deleteBuffer(buffer));
      if (program) attempt(() => gl.deleteProgram(program));
      for (const shader of shaders) attempt(() => gl.deleteShader(shader));
      shaders.length = 0; buffer = program = null; uniforms.clear();
      attempt(() => gl.getExtension("WEBGL_lose_context")?.loseContext());
      canvas.width = 0; canvas.height = 0;
    }
    function fail(error) {
      dispose(); document.documentElement.classList.add("no-webgl");
      console.error("Aura WebGL initialization failed", error?.message || String(error));
      global.AuraMemoryGuard?.disable();
    }
    const uniform = name => {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
      return uniforms.get(name);
    };
    const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) || 8192;
    function finish() {
      if (disposed || ready) return;
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) || "Shader link failed");
      gl.useProgram(program);
      buffer = gl.createBuffer(); if (!buffer) throw Error("WebGL buffer unavailable");
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, "a");
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0);
      ready = true;
      const callbacks = Array.from(pendingReady); pendingReady.clear();
      for (const fn of callbacks) fn();
    }
    try {
      canvas.addEventListener?.("webglcontextlost", onLost);
      global.addEventListener?.("resize", onResize);
      if (typeof global.ResizeObserver === "function") { observer = new global.ResizeObserver(onResize); observer.observe(canvas); }
      program = gl.createProgram(); if (!program) throw Error("WebGL program unavailable");
      for (const [type, source] of [[gl.FRAGMENT_SHADER,FRAG(MAXM)], [gl.VERTEX_SHADER,"attribute vec2 a; void main(){ gl_Position = vec4(a, 0., 1.); }"]]) {
        const shader = gl.createShader(type); if (!shader) throw Error("WebGL shader unavailable");
        shaders.push(shader); gl.shaderSource(shader,source); gl.compileShader(shader); gl.attachShader(program,shader);
      }
      gl.linkProgram(program);
      const parallel = gl.getExtension("KHR_parallel_shader_compile");
      function poll() {
        compileTimer = 0; if (disposed) return;
        try {
          if (!parallel || gl.getProgramParameter(program,parallel.COMPLETION_STATUS_KHR)) finish();
          else if (performance.now() - started > 10000) throw Error("Shader compilation deadline");
          else compileTimer = setTimeout(poll,16);
        } catch (error) { fail(error); }
      }
      poll();
    } catch (error) { fail(error); return null; }
    if (disposed) return null;
    return Object.freeze({
      max: MAXM,
      whenReady(fn) { if (disposed) return () => {}; if (ready) fn(); else pendingReady.add(fn); return () => pendingReady.delete(fn); },
      freeze(t) { frozen = t; },
      clock: () => (performance.now() - clockBase) / 1000,
      rebase(limit = 0) {
        if (disposed || (performance.now() - clockBase) / 1000 <= limit) return false;
        clockBase = performance.now();
        return true;
      },
      stats: () => ({ ready, disposed, draws, resizes, pixels: canvas.width * canvas.height, pending: pendingReady.size, compilePending: !!compileTimer, clock: (performance.now() - clockBase) / 1000 }),
      draw(s) {
        if (!ready || disposed || gl.isContextLost?.()) return false;
        if (sizeDirty || !observer) { cssWidth=Math.max(1,canvas.clientWidth); cssHeight=Math.max(1,canvas.clientHeight); sizeDirty=false; }
        const dprCap=Number.isFinite(s.dprCap) ? Math.max(.5,Math.min(2,s.dprCap)) : 2;
        const pixels=Number.isFinite(s.pixelBudget) ? Math.max(1,Math.min(MAX_FRAMEBUFFER_PIXELS,s.pixelBudget)) : MAX_FRAMEBUFFER_PIXELS;
        const wanted=Math.min(dprCap,global.devicePixelRatio || 1)*Math.max(.5,Math.min(1,s.quality || 1));
        const scale=Math.min(1,Math.sqrt(pixels/(cssWidth*cssHeight*wanted*wanted)),maxRenderbufferSize/(cssWidth*wanted),maxRenderbufferSize/(cssHeight*wanted));
        const dpr=wanted*scale;
        const w=Math.max(1,Math.floor(cssWidth*dpr)),h=Math.max(1,Math.floor(cssHeight*dpr));
        if(canvas.width!==w||canvas.height!==h){ if(canvas.width!==w)canvas.width=w; if(canvas.height!==h)canvas.height=h; gl.viewport(0,0,w,h); resizes++; }
        mini.fill(0);miniFx.fill(0);
        const n=Math.min(MAXM,s.minis.length);
        for(let i=0;i<n;i++){const m=s.minis[i],o=i*4;mini[o]=m.x;mini[o+1]=m.y;mini[o+2]=m.r;mini[o+3]=m.light;miniFx[o]=m.shift||0;miniFx[o+1]=m.frost||0;miniFx[o+2]=m.flash||0;miniFx[o+3]=m.alpha;}
        gl.uniform2f(uniform("uRes"),w,h);gl.uniform1f(uniform("uScale"),dpr);
        const visual=s.visual;
        // A user-selected curtain bypasses quality-tier edge defaults while
        // using this same shader, program, buffers and renderer process.
        effects[0]=s.curtain == null ? (visual?.edge ?? 1) : (s.curtain ? 1 : 0);
        effects[1]=visual?.halo ?? 1;
        effects[2]=visual?.ripple ?? 1; effects[3]=visual?.detail || 4;
        gl.uniform4fv(uniform("uEffects"),effects);
        const ultra = visual?.motion === 1;
        gl.uniform1f(uniform("uUltra"),ultra ? 1 : 0);
        gl.uniform4fv(uniform("uMotion"),s.motion?.values || quietMotion);
        gl.uniform4fv(uniform("uOrbit"),s.motion?.orbit || quietOrbit);
        const clock = frozen != null ? frozen : ultra && s.motion ? s.motion.orbit[2] : (performance.now()-clockBase)/1000;
        gl.uniform1f(uniform("uTime"),clock*(visual?.speed ?? 1));
        gl.uniform1f(uniform("uCurtainTime"),clock);
        gl.uniform1f(uniform("uOn"),s.on);gl.uniform1f(uniform("uActive"),s.active);gl.uniform1f(uniform("uPulse"),s.pulse);gl.uniform1f(uniform("uDim"),s.dim);gl.uniform1f(uniform("uNight"),s.night||0);
        gl.uniform4fv(uniform("uOrb"),s.orb);gl.uniform4fv(uniform("uMood"),s.mood);
        gl.uniform4fv(uniform("uMini"),mini);gl.uniform4fv(uniform("uMiniFx"),miniFx);gl.uniform1f(uniform("uMiniCount"),n);
        gl.drawArrays(gl.TRIANGLES,0,6);draws++;return true;
      },
      dispose,
    });
  }
  global.AuraScene = { create };
})(window);
