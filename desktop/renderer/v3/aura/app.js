/* 灵光 · application layer. Renders the HarnessCore state as sentences; every control talks to core.act. */
(async function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v; else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), event => {
        try { Promise.resolve(v(event)).catch(error => toast(error.message || String(error), "error")); }
        catch (error) { toast(error.message || String(error), "error"); }
      });
      else if (k === "dataset") Object.assign(el.dataset, v); else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const text = (el, v) => { if (el && el.textContent !== String(v)) el.textContent = v; };
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  const icon = cp => h("i", { class: "ic" }, cp);
  const RM = matchMedia("(prefers-reduced-motion: reduce)");
  const params = new URLSearchParams(location.search);

  let core;
  try { core = await HarnessCore.start(); }
  catch (error) {
    document.body.classList.remove("booting");
    document.body.classList.add("boot-error");
    text($("#live-who"), "连接启动器失败");
    text($("#live-what"), error.message || String(error));
    $("#live").dataset.tone = "err";
    $("#live").setAttribute("role", "alert");
    $$("button").forEach(button => { button.disabled = true; });
    return;
  }
  const A = core.act;
  const { hms, relative, duration } = core.fmt;
  const VIEWS = ["workspace", "skills", "logs", "settings"];
  const ui = { view: "workspace", source: "mcp", level: "all", query: "", hideHealth: false, autoscroll: true, logMode: "story", storyLimit: 1200, skillQuery: "", install: null, draft: null, dirty: false, pop: null, skillPop: null, lastSig: {}, guideStep: 0, liveKey: "" };
  const I = { check: "\uE73E", more: "\uE712", link: "\uE71B", close: "\uE711", open: "\uE8A7", copy: "\uE8C8", trash: "\uE74D", folder: "\uE8B7", key: "\uE8D7", net: "\uE968", list: "\uE8FD", globe: "\uE774", sync: "\uE8AB", laptop: "\uE7F8", wrench: "\uE90F", add: "\uE710", fallback: "\uE9D5", spark: "\uE945", chat: "\uE8BD", play: "\uE768", stop: "\uE71A", refresh: "\uE72C", info: "\uE946", warn: "\uE7BA", cloud: "\uE753", search: "\uE721", shield: "\uE83D", clock: "\uE823", bolt: "\uE945", moon: "\uE708", sun: "\uE706" };
  const TOOL_ICON = { read_text_file: "\uE8A5", list_directory: "\uE8B7", directory_tree: "\uE8B7", search_files: "\uE721", project_context: "\uE8FD", git_status: "\uE8AB", git_diff: "\uE8AB", git_log: "\uE81C", run_command: "\uE756", apply_patch: "\uE70F", code_intelligence: "\uE943", node_repl: "\uE943", load_skill: "\uE945", list_skills: "\uE945", agent_status: "\uE9D9", computer_use: "\uE7F4", goal: "\uE7C1" };

  /* Shared sentence-style choices. The native select remains the value source;
     the themed list is also usable with arrows, Home/End, Enter, Escape and Tab. */
  let activeChoice = null;
  function choice(select, label, style = "") {
    const value = h("span", { class: "choice-value" });
    const trigger = h("button", { type: "button", id: select.id + "-trigger", class: "choice-trigger", role: "combobox", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-controls": select.id + "-list" }, value, h("span", { class: "choice-chevron", "aria-hidden": "true" }));
    const menu = h("div", { class: "choice-menu", id: select.id + "-list", role: "listbox", "aria-label": label, popover: "manual" });
    const wrap = h("span", { class: "choice " + style });
    if (select.parentNode) select.replaceWith(wrap);
    select.hidden = true; select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
    wrap.append(select, trigger);
    let opened = false, cursor = -1, search = "", searchedAt = 0;
    const enabled = () => Array.from(select.options).map((o, i) => o.disabled ? -1 : i).filter(i => i >= 0);
    const close = (restore = false) => {
      if (!opened) return;
      opened = false; trigger.setAttribute("aria-expanded", "false"); trigger.removeAttribute("aria-activedescendant");
      if (menu.matches(":popover-open")) menu.hidePopover();
      menu.remove(); if (activeChoice?.trigger === trigger) activeChoice = null;
      if (restore && !trigger.disabled) trigger.focus({ preventScroll: true });
    };
    const highlight = index => {
      cursor = index;
      Array.from(menu.children).forEach((option, i) => option.classList.toggle("active", i === index));
      if (index >= 0) { trigger.setAttribute("aria-activedescendant", select.id + "-option-" + index); menu.children[index]?.scrollIntoView({ block: "nearest" }); }
    };
    const sync = () => {
      const selected = select.options[select.selectedIndex];
      text(value, selected?.textContent || "选择账户");
      trigger.setAttribute("aria-label", label + "：" + (selected?.textContent || "未选择"));
      trigger.disabled = select.disabled || !select.options.length;
      if (trigger.disabled) close();
    };
    const choose = index => {
      if (index < 0 || select.options[index]?.disabled || select.disabled) return;
      const changed = select.selectedIndex !== index;
      select.selectedIndex = index; sync(); close(true);
      if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const open = () => {
      if (trigger.disabled || opened) return;
      activeChoice?.close();
      trigger.focus({ preventScroll: true });
      menu.replaceChildren(...Array.from(select.options).map((option, index) => h("button", { type: "button", role: "option", id: select.id + "-option-" + index, tabindex: "-1", "aria-selected": String(index === select.selectedIndex), disabled: option.disabled, onclick: () => choose(index) }, h("span", null, option.textContent), index === select.selectedIndex ? icon(I.check) : null)));
      (select.closest("dialog") || document.body).append(menu);
      const r = trigger.getBoundingClientRect(), width = Math.min(Math.max(r.width, 224), innerWidth - 32);
      const below = innerHeight - r.bottom - 20, above = r.top - 20;
      const upwards = below < 220 && above > below;
      menu.style.width = width + "px";
      menu.style.maxHeight = Math.max(80, Math.min(320, upwards ? above : below)) + "px";
      menu.style.left = Math.max(16, Math.min(r.left, innerWidth - width - 16)) + "px";
      menu.showPopover();
      menu.style.top = (upwards ? Math.max(16, r.top - menu.getBoundingClientRect().height - 8) : r.bottom + 8) + "px";
      opened = true; trigger.setAttribute("aria-expanded", "true");
      activeChoice = { close, menu, trigger, wrap };
      highlight(select.selectedIndex >= 0 && !select.options[select.selectedIndex]?.disabled ? select.selectedIndex : enabled()[0] ?? -1);
    };
    trigger.addEventListener("click", () => opened ? close() : open());
    trigger.addEventListener("keydown", event => {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const wasOpen = opened; open(); const options = enabled();
        if (!options.length) return;
        if (event.key === "Home") highlight(options[0]);
        else if (event.key === "End") highlight(options[options.length - 1]);
        else if (wasOpen) highlight(options[(options.indexOf(cursor) + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); opened ? choose(cursor) : open();
      } else if (event.key === "Escape" && opened) {
        event.preventDefault(); event.stopPropagation(); close(true);
      } else if (event.key === "Tab") close();
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        search = Date.now() - searchedAt < 650 ? search + event.key : event.key; searchedAt = Date.now();
        open(); const index = enabled().find(i => select.options[i].textContent.toLocaleLowerCase().startsWith(search.toLocaleLowerCase()));
        if (index !== undefined) { event.preventDefault(); highlight(index); }
      }
    });
    menu.addEventListener("pointerdown", event => event.preventDefault());
    select.addEventListener("change", sync);
    select._auraChoice = { sync, close, trigger };
    sync(); return wrap;
  }
  document.addEventListener("pointerdown", event => { if (activeChoice && !activeChoice.wrap.contains(event.target) && !activeChoice.menu.contains(event.target)) activeChoice.close(); });
  document.addEventListener("scroll", event => { if (activeChoice && !activeChoice.menu.contains(event.target)) activeChoice.close(); }, true);
  window.addEventListener("resize", () => activeChoice?.close());

  /* ===================== springs & sliding indicators ===================== */
  function spring(x, k = 300, c = 30) {
    let v = 0, t = x;
    return {
      set(n) { t = n; }, jump(n) { x = t = n; v = 0; },
      step(dt) { if (RM.matches) { x = t; v = 0; return x; } const a = -k * (x - t) - c * v; v += a * dt; x += v * dt; if (Math.abs(x - t) < .002 && Math.abs(v) < .002) { x = t; v = 0; } return x; },
      get value() { return x; }, get target() { return t; }, get idle() { return x === t && v === 0; }
    };
  }
  function slider(el, axis = "x") {
    let a = null, b = null;
    return {
      el,
      to(start, size) {
        const end = start + size;
        if (!a || RM.matches) { a = spring(start, 520, 44); b = spring(end, 520, 44); a.jump(start); b.jump(end); return; }
        const dir = start >= a.target ? 1 : -1;
        const na = spring(a.value, ...(dir < 0 ? [560, 42] : [200, 25])), nb = spring(b.value, ...(dir > 0 ? [560, 42] : [200, 25]));
        na.set(start); nb.set(end); a = na; b = nb;
      },
      step(dt) {
        if (!a) return true;
        const s = a.step(dt), e = b.step(dt);
        if (axis === "x") { el.style.transform = `translateX(${s}px)`; el.style.width = Math.max(6, e - s) + "px"; }
        else { el.style.transform = `translateY(${s}px)`; el.style.height = Math.max(6, e - s) + "px"; }
        return a.idle && b.idle;
      }
    };
  }
  const bars = [];
  const mk = (el, axis) => { const s = slider(el, axis); bars.push(s); return s; };
  const navBar = mk($("#nav-indicator")), srcBar = mk($("#seg-source .tab-line")), lvlBar = mk($("#seg-level .seg-ind")), modeBar = mk($("#seg-mode .seg-ind"));
  let toolBar = null, proxyBar = null, remindBar = null;
  function placeIndicators() {
    const x = (b, t, pad = 0) => { if (b && t && t.offsetParent) b.to(t.offsetLeft - pad, t.offsetWidth); };
    x(navBar, $(`#nav [data-view="${ui.view}"]`), 4);
    x(srcBar, $(`#seg-source [data-source="${ui.source}"]`));
    x(lvlBar, $(`#seg-level [data-level="${ui.level}"]`), 4);
    x(modeBar, $(`#seg-mode [data-mode="${ui.logMode}"]`), 4);
    if (ui.draft) { x(toolBar, $(`#tool-chips [data-value="${ui.draft.toolProfile}"]`), 4); x(proxyBar, $(`#proxy-chips [data-value="${ui.draft.tunnelProxyMode}"]`), 4); }
    x(themeBar, $(`#theme-chips [data-value="${theme.choice}"]`), 4);
    x(remindBar, $('#remind-chips [aria-checked="true"]'), 4);
    kick();
  }

  /* ===================== scene: presence orb, small orbs, edge glow ===================== */
  const scene = AuraScene.create($("#scene"));
  const P = { x: spring(0, 120, 20), y: spring(0, 120, 20), r: spring(100, 120, 20), vis: spring(1, 90, 19) };
  const on = spring(0, 40, 13), active = spring(0, 60, 15), warm = spring(0, 40, 13), alarm = spring(0, 40, 13), busy = spring(0, 40, 13), dim = spring(0, 90, 19);
  let pulseStart = -1, activeUntil = 0;

  /* ===================== appearance: day and night ===================== */
  // theme-boot.js already applied the saved choice before first paint; this keeps it in sync afterwards.
  const THEME_KEY = "wh.aura.theme", darkQuery = matchMedia("(prefers-color-scheme: dark)");
  const themeOf = choice => choice === "dark" || (choice === "system" && darkQuery.matches) ? "dark" : "light";
  const theme = { choice: ["light", "dark"].includes(document.documentElement.dataset.themeChoice) ? document.documentElement.dataset.themeChoice : "system", timer: 0 };
  const night = spring(themeOf(theme.choice) === "dark" ? 1 : 0, 60, 15);
  let themeBar = null;
  function applyTheme(choice, { persist = true } = {}) {
    const root = document.documentElement, next = themeOf(choice);
    theme.choice = choice;
    if (persist) { try { if (choice === "system") localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, choice); } catch (_) { /* keeps working for this session */ } }
    if (root.dataset.theme !== next && !RM.matches) {
      // colours cross-fade together with the scene for one beat, then normal transitions resume
      root.classList.add("theme-shift"); clearTimeout(theme.timer); theme.timer = setTimeout(() => root.classList.remove("theme-shift"), 650);
    }
    root.dataset.theme = next; root.dataset.themeChoice = choice;
    night.set(next === "dark" ? 1 : 0);
    syncThemeControls();
    kick();
  }
  function syncThemeControls() {
    const dark = document.documentElement.dataset.theme === "dark", b = $("#btn-theme");
    b.setAttribute("aria-pressed", String(dark)); b.setAttribute("aria-label", dark ? "切换到浅色模式" : "切换到夜间模式"); b.title = dark ? "浅色模式" : "夜间模式";
    text(b.querySelector(".ic"), dark ? I.sun : I.moon);
    $$("#theme-chips [data-value]").forEach(c => c.setAttribute("aria-checked", String(c.dataset.value === theme.choice)));
    requestAnimationFrame(placeIndicators);
  }
  darkQuery.addEventListener("change", () => { if (theme.choice === "system") applyTheme("system", { persist: false }); });

  /* ===================== idle reminder: a conversation that went quiet ===================== */
  // The main process watches every account; this only edits the interval. It is saved on its
  // own, outside the settings draft, so it can change while services are running.
  const REMIND_CHOICES = [5, 10, 15, 0];
  const reminderOf = s => { const m = Number((s.account.config || {}).idleReminderMinutes); return REMIND_CHOICES.includes(m) ? m : 5; };
  function syncRemindControls(value = reminderOf(core.snapshot())) {
    $$("#remind-chips [data-value]").forEach(c => c.setAttribute("aria-checked", String(c.dataset.value === String(value))));
    requestAnimationFrame(placeIndicators);
  }
  async function setReminder(minutes) {
    syncRemindControls(minutes);
    try {
      await A.setIdleReminder(minutes);
      toast(minutes ? `已设为 ${minutes} 分钟提醒。` : "已关闭空档提醒。");
    } catch (err) { if (err.code !== "STALE") toast(err.message, "error"); }
    finally { syncRemindControls(); }
  }
  const SOUND_LABELS = [["glass","琉璃三连"],["waterdrop","水滴双音"],["xylophone","木琴轻敲"],["bells","清亮风铃"],["digital","电子短讯"],["custom","自定义音效"]];
  async function refreshSoundControls() {
    const accountId=core.snapshot().selectedId,settings=await A.getNotificationSounds();
    if(core.snapshot().selectedId!==accountId)return;
    const picker=$("#sound-choice"),volume=$("#sound-volume");
    if(!picker||!volume)return;
    picker.value=settings.selected;
    const customOption=picker.querySelector('[value="custom"]');
    if(customOption)customOption.disabled=!settings.hasCustom;
    picker._auraChoice?.sync();
    volume.value=String(settings.volume);
    volume.style.setProperty("--volume", settings.volume+"%");
    text($("#sound-volume-value"),settings.volume+"%");
  }
  async function soundImportBytes(file) {
    if(!file||file.size>8*1024*1024||file.size<44)throw Error("只能导入不超过 8MB 的 WAV 或 MP3 音频。");
    if(!/\.(wav|mp3)$/i.test(file.name))throw Error("请选择 WAV 或 MP3 文件。");
    const Audio=window.AudioContext||window.webkitAudioContext;
    if(!Audio||!window.OfflineAudioContext)throw Error("当前浏览器音频解码能力不可用。");
    const ctx=new Audio();
    try {
      const decoded=await ctx.decodeAudioData(await file.arrayBuffer());
      if(!Number.isFinite(decoded.duration)||decoded.duration<.3||decoded.duration>120)
        throw Error("自定义音频需要在 0.3 秒到 2 分钟之间，最长使用前 5 秒。");
      const duration=Math.min(5,decoded.duration),length=Math.floor(duration*44100);
      const offline=new OfflineAudioContext(1,length,44100);
      const player=offline.createBufferSource();
      player.buffer=decoded;player.connect(offline.destination);player.start(0);
      const rendered=await offline.startRendering(),samples=rendered.getChannelData(0);
      const wav=new ArrayBuffer(44+length*2),view=new DataView(wav);
      const ascii=(offset,s)=>{for(let j=0;j<s.length;j++)view.setUint8(offset+j,s.charCodeAt(j));};
      ascii(0,"RIFF");view.setUint32(4,wav.byteLength-8,true);ascii(8,"WAVEfmt ");
      view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
      view.setUint32(24,44100,true);view.setUint32(28,88200,true);view.setUint16(32,2,true);
      view.setUint16(34,16,true);ascii(36,"data");view.setUint32(40,length*2,true);
      for(let j=0;j<length;j++){
        const a=Math.max(-1,Math.min(1,samples[j]));
        view.setInt16(44+j*2,Math.round(a*32767),true);
      }
      const bytes=new Uint8Array(wav);
      let base64="";
      for(let i=0;i<bytes.length;i+=8190)
        base64+=btoa(String.fromCharCode(...bytes.subarray(i,i+8190)));
      return {wavBase64:base64,duration};
    }finally{await ctx.close().catch(()=>{});}
  }
  async function importCustomSound(file) {
    if(!file)return;
    const accountId=core.snapshot().selectedId;
    const encoded=await soundImportBytes(file);
    if(core.snapshot().selectedId!==accountId)throw Error("账号已切换，请在当前账号重新选择音频。");
    await A.importNotificationAudio(encoded.wavBase64);
    await refreshSoundControls();
    toast("已保存自定义提示音。");
  }
  async function refreshConversationControls() {
    const accountId=core.snapshot().selectedId,rows=await A.listConversationNames();
    if(core.snapshot().selectedId!==accountId)return;
    const box=$("#conversation-label-list");if(!box)return;
    text($("#conversation-count"), rows.length ? rows.length + " 个会话" : "");
    $("#btn-clear-conversations").disabled = !rows.some(row => !row.pinned);
    if(!rows.length) {fill(box,h("p",{class:"conversation-empty"},"暂无会话"));return;}
    fill(box,rows.map(row=>{
      const input=h("input",{type:"text",maxlength:"40",placeholder:"可选备注",value:row.title||"","aria-label":row.display+" 备注"});
      return h("div",{class:"conversation-item"},
        h("span",null,row.display),
        input,
        h("button",{type:"button",class:"ghost",onclick:async event=>{
          if(core.snapshot().selectedId!==accountId)throw Error("账户已切换，请重新打开会话标签。");
          const button=event.currentTarget;button.disabled=true;
          try { await A.renameConversation(row.id,input.value);if(core.snapshot().selectedId!==accountId)return;await refreshConversationControls();toast("已保存会话备注。"); }
          finally {button.disabled=false;}
        }},"保存"),
        h("button",{type:"button",class:"ghost",onclick:async event=>{
          if(core.snapshot().selectedId!==accountId)throw Error("账户已切换，请重新打开会话标签。");
          const button=event.currentTarget;button.disabled=true;
          try {await A.pinConversation(row.id,!row.pinned);if(core.snapshot().selectedId!==accountId)return;await refreshConversationControls();}
          finally {button.disabled=false;}
        }},row.pinned?"取消保留":"保留"));
    }));
  }
  $("#btn-theme").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  function presenceTarget() {
    const el = ui.view === "workspace" ? $("#orb-slot") : $("#brand-orb");
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
  }
  function placePresence(jump) { const T = presenceTarget(), op = jump ? "jump" : "set"; P.x[op](T.x); P.y[op](T.y); P.r[op](T.r); kick(); }
  // small orbs: each [data-orb] element carries its own light
  function orbLook(el, o) {
    const g = el._o || (el._o = { light: 0, lightT: 0, shift: 0, frost: 0, flash: 0 });
    if ("light" in o) g.lightT = o.light;
    if ("shift" in o) g.shift = o.shift;
    if ("frost" in o) g.frost = o.frost;
    if (o.flash) g.flash = 1;
    if (o.jump) g.light = g.lightT;
    kick();
  }
  const chainCache = new WeakMap();
  const chainOf = el => { let c = chainCache.get(el); if (!c) { c = []; for (let n = el; n && n !== document.body; n = n.parentElement) c.push(n); chainCache.set(el, c); } return c; };
  function collectOrbs(dt) {
    const out = []; let moving = false; const e = 1 - Math.exp(-dt * 6);
    for (const el of document.querySelectorAll("[data-orb]")) {
      if (el.dataset.orb === "presence" || el.dataset.orb === "save") continue;
      const chain = chainOf(el);
      if (!el.isConnected || chain.some(n => n.hidden)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.bottom < 0 || r.top > innerHeight) continue;
      if (el._clip === undefined) el._clip = el.closest(".scroll");
      if (el._clip) { const c = el._clip.getBoundingClientRect(); if (r.top + r.height / 2 < c.top || r.top + r.height / 2 > c.bottom) continue; }
      let alpha = 1; for (const n of chain) { const o = +getComputedStyle(n).opacity; if (o < 1) alpha *= o; }
      if (alpha < .01) continue;
      const g = el._o || { light: 0, lightT: 0, shift: 0, frost: 0, flash: 0 };
      if (Math.abs(g.lightT - g.light) > .002) { g.light += (g.lightT - g.light) * e; moving = true; } else g.light = g.lightT;
      if (g.flash > .002) { g.flash *= Math.exp(-dt * 2.2); moving = true; } else g.flash = 0;
      out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2, light: g.light, shift: g.shift, frost: g.frost, flash: g.flash, alpha });
    }
    return { minis: out, moving };
  }
  // adaptive resolution: if frames run long (slow GPU), render fewer pixels; recover when there is headroom
  const governor = { q: 1, samples: [], step(dt) {
    this.samples.push(dt); if (this.samples.length < 50) return;
    const s = this.samples.sort((a, b) => a - b), med = s[s.length >> 1]; this.samples = [];
    if (med > .024 && this.q > .55) this.q = Math.max(.55, this.q - .15);
    else if (med < .0175 && this.q < 1) this.q = Math.min(1, this.q + .05);
  } };
  let raf = 0, last = 0, settle = 0, inFrame = false;
  // kick() from inside a frame only extends the settle window; the frame schedules itself once
  function kick() { settle = 40; if (!raf && !inFrame) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0; inFrame = true;
    const rawDt = last ? (now - last) / 1000 : 1 / 60, dt = Math.min(.05, rawDt); last = now;
    if (rawDt < .2) governor.step(rawDt);
    let moving = false;
    for (const b of bars) if (!b.step(dt)) moving = true;
    if (ui.view === "workspace" || P.vis.target) placePresence(false);
    const springs = [P.x, P.y, P.r, P.vis, on, active, warm, alarm, busy, dim, night];
    const v = springs.map(s => s.step(dt));
    if (springs.some(s => !s.idle)) moving = true;
    if (activeUntil && Date.now() > activeUntil) { activeUntil = 0; active.set(core.snapshot().activity.some(r => r.phase === "running") ? 1 : 0); }
    const pulse = pulseStart < 0 ? 0 : (now - pulseStart) / 1600;
    if (pulse > 0 && pulse < 1) moving = true;
    const { minis, moving: m2 } = collectOrbs(dt);
    if (scene) scene.draw({ orb: [v[0], v[1], v[2], Math.max(0, Math.min(1, v[3]))], on: Math.max(0, Math.min(1, v[4])), active: Math.max(0, Math.min(1, v[5])), pulse: pulse > 0 && pulse < 1 ? pulse : 0, mood: [Math.max(0, v[6]), Math.max(0, v[7]), Math.max(0, v[8]), 0], dim: v[9], night: Math.max(0, Math.min(1, v[10])), minis, quality: governor.q });
    if (moving || m2) settle = 40;
    inFrame = false;
    if ((!RM.matches && !document.hidden && !params.has("still")) || settle-- > 0) raf = requestAnimationFrame(frame);
  }
  if (scene && params.has("t")) scene.freeze(Number(params.get("t")));
  if (scene && RM.matches) scene.freeze(9);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
  addEventListener("resize", () => { placePresence(true); placeIndicators(); });
  document.addEventListener("scroll", kick, { passive: true, capture: true });
  document.addEventListener("transitionrun", kick, { passive: true });
  document.addEventListener("animationstart", kick, { passive: true });

  /* ===================== view switching ===================== */
  function setView(name, opts = {}) {
    if (!VIEWS.includes(name)) return;
    closePop(); closeMenu(); closeSkillPop(); activeChoice?.close();
    const prev = ui.view;
    ui.view = name; document.body.dataset.view = name;
    $$("#nav [role=tab]").forEach(t => t.setAttribute("aria-selected", String(t.dataset.view === name)));
    for (const v of VIEWS) {
      const el = $("#view-" + v);
      if (v === name) { el.hidden = false; el.classList.remove("leaving"); if (prev !== name) { el.classList.remove("entering"); void el.offsetWidth; el.classList.add("entering"); setTimeout(() => el.classList.remove("entering"), 640); } }
      else if (v === prev && prev !== name) { el.classList.add("leaving"); setTimeout(() => { el.classList.remove("leaving"); if (ui.view !== v) el.hidden = true; }, 200); }
      else el.hidden = true;
    }
    placePresence(false);
    requestAnimationFrame(placeIndicators);
    if (name === "logs") { renderLogs(); renderSpectrum(core.snapshot()); }
    if (name === "skills") autoRefreshSkills();
    if (name === "settings" && opts.pane) setTimeout(() => goChapter(opts.pane), 80);
    history.replaceState(null, "", "?" + new URLSearchParams({ ...Object.fromEntries(params), sheet: name }));
    kick();
  }
  $$("#nav [role=tab]").forEach(t => t.addEventListener("click", () => setView(t.dataset.view)));
  $("#nav").addEventListener("keydown", e => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const i = (VIEWS.indexOf(ui.view) + (e.key === "ArrowRight" ? 1 : 3)) % 4; setView(VIEWS[i]); $(`#nav [data-view="${VIEWS[i]}"]`).focus();
  });
  document.addEventListener("click", e => {
    const go = e.target.closest("[data-go]"); if (go) setView(go.dataset.go, { pane: go.dataset.pane });
    const gd = e.target.closest("[data-guide]"); if (gd) { closePop(); openGuide(); }
  });

  /* ===================== toast ===================== */
  let toastTimer = 0;
  function toast(message, level = "info") {
    const el = $("#toast");
    text($("#toast-text"), message); el.classList.toggle("error", level === "error");
    el.classList.remove("show"); void el.offsetWidth; el.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), level === "error" ? 6500 : 3800);
  }
  $("#toast").addEventListener("click", () => $("#toast").classList.remove("show"));
  core.on("notice", n => toast(n.message, n.level));

  /* ===================== dialogs ===================== */
  function openDialog(d) { if (d.open) return; activeChoice?.close(); d.showModal(); dim.set(1); kick(); d.addEventListener("close", () => { activeChoice?.close(); if (!$("dialog[open]")) { dim.set(0); kick(); } }, { once: true }); }
  function confirmBox(title, desc, ok = "确认", danger = true) {
    return new Promise(resolve => {
      const d = $("#dlg-confirm");
      text($("#confirm-title"), title); text($("#confirm-desc"), desc); text($("#confirm-ok"), ok);
      $("#confirm-ok").classList.toggle("danger", danger);
      d.returnValue = ""; openDialog(d);
      d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true });
    });
  }
  function nameBox(mode, current) {
    return new Promise(resolve => {
      const d = $("#dlg-account");
      text($("#account-title"), mode === "create" ? "新建账户" : "重命名账户");
      text($("#account-desc"), mode === "create" ? "新账户使用独立端口与配置，不会复制其他账户的密钥。" : `当前名称：${current}`);
      text($("#account-ok"), mode === "create" ? "创建账户" : "保存名称");
      const input = $("#account-name-input"); input.value = mode === "create" ? "" : current;
      d.returnValue = ""; openDialog(d); input.select();
      d.addEventListener("close", () => resolve(d.returnValue === "ok" ? input.value.trim() : null), { once: true });
    });
  }
  function showInfo() {
    const s = core.snapshot(), a = s.account, c = a.config || {}, d = s.derived;
    const rows = [["账户", a.name], ["账户 ID", a.id, 1], ["工作区", c.workspacePath || "未配置", 1], ["MCP 端口", c.mcpPort], ["Admin 端口", c.adminPort], ["Tunnel 端口", c.tunnelPort],
      ["版本", s.info.version || "—"], ["构建", (a.mcp && a.mcp.build) || s.info.build || "—", 1], ["工具集", d.mcp.tools], ["MCP PID", d.mcp.pid], ["Tunnel PID", d.tunnel.pid], ["状态", `${d.title}。${d.caption}`]];
    text($("#info-title"), a.name);
    $("#info-kv").replaceChildren(...rows.flatMap(([k, v, isMono]) => [h("dt", null, k), h("dd", { class: isMono ? "mono" : null }, String(v))]));
    $("#btn-copy-info").onclick = run(() => A.copyText(rows.map(([k, v]) => `${k}: ${v}`).join("\n"), "运行信息"));
    openDialog($("#dlg-info"));
  }
  $("#btn-info").addEventListener("click", showInfo);

  /* ===================== account menu ===================== */
  function openMenu() { const m = $("#account-menu"); m.hidden = false; $("#account-btn").setAttribute("aria-expanded", "true"); m.querySelector("[aria-checked='true'], button")?.focus(); }
  function closeMenu() { const m = $("#account-menu"); if (m.hidden) return; $("#account-btn").setAttribute("aria-expanded", "false"); m.hidden = true; }
  $("#account-btn").addEventListener("click", e => { e.stopPropagation(); $("#account-menu").hidden ? openMenu() : closeMenu(); });
  document.addEventListener("click", e => { if (!e.target.closest("#account")) closeMenu(); });
  $("#btn-account-create").addEventListener("click", async () => { closeMenu(); const name = await nameBox("create"); if (name) try { await A.createAccount(name); } catch (err) { toast(err.message, "error"); } });
  $("#btn-account-rename").addEventListener("click", async () => { closeMenu(); const s = core.snapshot(); const name = await nameBox("rename", s.account.name); if (name) try { await A.renameAccount(s.selectedId, name); toast("账户已重命名。"); } catch (err) { toast(err.message, "error"); } });
  async function openAccountImport() {
    closeMenu();
    try {
      const review = await A.inspectAccountImport();
      if (!review) return;
      ui.importReview = review;
      ui.importNeedsRefresh = false;
      text($("#import-source"), review.sourceFolder);
      $("#import-choice").replaceChildren(...review.accounts.map(row => h("option", { value: row.sourceId }, row.name)));
      $("#import-choice")._auraChoice?.sync();
      $("#import-details").open = false;
      $("#import-error").hidden = true; renderImportChoice(); openDialog($("#dlg-account-import"));
    } catch (error) { toast(error.message, "error"); }
  }
  function renderImportChoice() {
    const row = ui.importReview?.accounts.find(item => item.sourceId === $("#import-choice").value);
    $("#import-confirm").disabled = !row;
    if (!row) return;
    text($("#import-overview"), `${row.installedSkills ?? 0} 个 Skill · ${row.mcpServers ?? 0} 个 MCP 服务`);
    kv("#import-summary", [["工作区", row.workspacePath || "未设置"], ["MCP 端口", row.mcpPort], ["Admin 端口", row.adminPort], ["Tunnel 端口", row.tunnelPort], ["初始化", row.setupDone ? "已完成" : "尚未完成"], ["密钥", row.hasApiKey ? "已保存（加密）" : "未保存"], ["已安装 Skills", row.installedSkills ?? 0], ["已注册 Skills", row.registeredSkills ?? 0], ["MCP 服务", row.mcpServers ?? 0], ["提示音", row.hasCustomAudio ? "自定义" : "默认"], ["会话标签", row.hasConversationNames ? "有" : "无"]]);
    const warning = row.existingAccountId ? "补齐缺项，保留当前密钥与端口。请先停止该账户的服务。" : row.warning || "";
    text($("#import-note"), warning);
    $("#import-note").hidden = !warning;
    text($("#import-scope"), [row.warning, "导入包含账户配置、Skills、MCP、会话标签和提示音。遇到冲突时停止并保留备份；主题、网页聊天内容和服务运行状态不迁移。"].filter(Boolean).join(" "));
    text($("#import-confirm"), ui.importNeedsRefresh ? "重新选择目录" : row.existingAccountId ? "补全已有账户" : "安全导入账户");
  }
  $("#btn-account-import").addEventListener("click", openAccountImport);
  choice($("#import-choice"), "旧账户", "choice-account");
  $("#import-choice").addEventListener("change", () => { $("#import-error").hidden = true; renderImportChoice(); });
  $("#import-confirm").addEventListener("click", async () => {
    if (ui.importNeedsRefresh && !ui.importing) { $("#dlg-account-import").close(); return openAccountImport(); }
    if (ui.importing || !ui.importReview) return;
    ui.importing = true; $("#import-confirm").disabled = true; $("#import-cancel").disabled = true;
    $("#import-choice").disabled = true; $("#import-choice")._auraChoice.sync();
    try {
      await A.importAccount({ token: ui.importReview.token, sourceId: $("#import-choice").value });
      $("#dlg-account-import").close(); setView("settings"); fillForm(core.snapshot());
    } catch (error) { text($("#import-error"), error.message); $("#import-error").hidden = false; ui.importNeedsRefresh = true; text($("#import-confirm"), "重新选择目录"); }
    finally { ui.importing = false; $("#import-confirm").disabled = false; $("#import-cancel").disabled = false; $("#import-choice").disabled = false; $("#import-choice")._auraChoice.sync(); }
  });
  $("#dlg-account-import").addEventListener("cancel", event => { if (ui.importing) event.preventDefault(); });
  $("#btn-account-remove").addEventListener("click", async () => {
    closeMenu();
    const s = core.snapshot(), a = s.account;
    if (s.pending.size || s.derived.busy || a.mcp.managed || a.tunnel.managed) return toast("请先停止此账户的 MCP 和隧道。", "error");
    const desc = `移除「${a.name}」？配置将备份，工作区保留。` + (s.accounts.length === 1 ? "将新建空白账户。" : "");
    if (!await confirmBox("移除当前账户", desc, "移除账户")) return;
    try {
      const result = await A.removeAccount(a.id);
      if (result.backup?.created) {
        text($("#info-title"), "账户已移除");
        $("#info-kv").replaceChildren(h("dt", null, "工作区"), h("dd", null, "文件已保留"), h("dt", null, "本机恢复备份"), h("dd", { class: "mono" }, result.backup.path));
        $("#btn-copy-info").onclick = run(() => A.copyText(result.backup.path, "恢复备份路径"));
        openDialog($("#dlg-info"));
      }
    } catch (err) { toast(err.message, "error"); }
  });
  function renderAccounts(s) {
    const sig = s.accounts.map(a => a.id + a.name).join("|") + s.selectedId;
    text($("#account-name"), s.account.name); text($("#avatar"), (s.account.name || "H").trim().slice(0, 1));
    if (ui.lastSig.accounts === sig) return; ui.lastSig.accounts = sig;
    text($("#account-count"), `${s.accounts.length} 个`);
    $("#account-list").replaceChildren(...s.accounts.map(a => h("button", { class: "menu-item", type: "button", role: "menuitemradio", "aria-checked": String(a.id === s.selectedId), onclick: async () => { closeMenu(); if (a.id !== s.selectedId) { try { await A.selectAccount(a.id); } catch (err) { toast(err.message, "error"); } } } },
      h("span", { class: "avatar" }, (a.name || "H").slice(0, 1)), h("span", null, h("b", null, a.name), h("small", null, (a.config && a.config.workspacePath) || "未配置工作区")), a.id === s.selectedId ? icon(I.check) : null)));
  }

  /* ===================== switches ===================== */
  function travel(b) { b.classList.add("moving"); clearTimeout(b._tt); b._tt = setTimeout(() => b.classList.remove("moving"), RM.matches ? 0 : 280); }
  function sw(b, v) { if (b.getAttribute("aria-checked") !== String(v)) b.setAttribute("aria-checked", String(v)); }
  function switchEl(v, label, onChange, key) {
    const b = h("button", { class: "switch", type: "button", role: "switch", "aria-checked": String(!!v), "aria-label": label, dataset: { key } }, h("i"));
    b.addEventListener("click", () => { const next = b.getAttribute("aria-checked") !== "true"; travel(b); sw(b, next); onChange(next); });
    return b;
  }

  /* ===================== 工作空间: the live sentence ===================== */
  function liveSentence(s) {
    const d = s.derived, m = s.account.mcp, t = s.account.tunnel, c = s.account.config || {};
    const run = [...s.activity].reverse().find(r => r.phase === "running");
    if (!c.setupDone) return ["这个账户", "还没有配置连接。", "warn"];
    if (m.state === "stopping" || t.state === "stopping") return ["正在停止", "等待本机进程退出。", "busy"];
    if (m.state === "starting" || t.state === "starting") return ["正在点亮", "本机工具与安全隧道。", "busy"];
    if (t.authError) return ["云端认证失败", "请核对 API Key 和 Tunnel ID。", "err"];
    if (m.state === "error" || t.state === "error") return ["服务异常退出", "查看事件日志，再重启。", "err"];
    if (m.portOccupiedByUnknown || t.portOccupiedByUnknown) return ["端口被占用", "换一个端口；不会结束外部进程。", "warn"];
    if (t.metaError || t.cloudState === "error" || t.cloudState === "stale") return ["云端连接待恢复", "检查代理、网络或隧道日志。", "warn"];
    if (d.cloudOnline && run) { const n = core.describe(run); return [`ChatGPT 正在${n.verb}`, run.target || run.tool, "run"]; }
    if (d.cloudOnline) return ["ChatGPT 已连接", "随时可以开始工作。", "ok"];
    if (m.healthy && t.ready) return ["本机已就绪", "等待 ChatGPT 确认连接。", "warn"];
    if (m.healthy) return ["本机工具已就绪", "启动隧道，连接 ChatGPT。", "idle"];
    return ["这台电脑", "还没有连接 ChatGPT。", "idle"];
  }
  function setBtn(el, disabled, isBusy) { el.disabled = !!(disabled || isBusy); el.setAttribute("aria-busy", String(!!isBusy)); }
  function renderWorkspace(s) {
    const d = s.derived, a = s.account, m = a.mcp, t = a.tunnel, c = a.config || {}, p = s.pending;
    const [who, what, tone] = liveSentence(s);
    const key = who + "|" + what;
    if (ui.liveKey !== key) {
      ui.liveKey = key;
      const live = $("#live"); text($("#live-who"), who); text($("#live-what"), what); live.dataset.tone = tone;
      live.classList.remove("fresh"); void live.offsetWidth; if (!RM.matches) live.classList.add("fresh");
    }
    // the orb and the window edge carry the state
    on.set(d.cloudOnline ? 1 : (m.healthy && t.ready) ? .55 : m.healthy ? .3 : 0);
    warm.set(tone === "warn" ? 1 : 0); alarm.set(tone === "err" ? 1 : 0); busy.set(tone === "busy" ? 1 : 0);
    document.body.dataset.link = d.cloudOnline ? "on" : "off";
    const row = (id, v, tn) => { const el = $(id); text(el, v); if (tn) el.dataset.tone = tn; else delete el.dataset.tone; el.title = v; };
    row("#s-local", m.portOccupiedByUnknown ? `端口 ${c.mcpPort} 被占用` : m.healthy ? `${m.toolCount} 个工具，端口 ${c.mcpPort}` : m.state === "error" ? "异常退出" : m.state === "starting" ? "启动中" : `未运行，端口 ${c.mcpPort}`, m.state === "error" ? "err" : m.portOccupiedByUnknown ? "warn" : null);
    row("#s-tunnel", d.tunnelBadge.text, d.tunnelBadge.tone === "err" ? "err" : d.tunnelBadge.tone === "warn" ? "warn" : null);
    row("#s-cloud", d.cloudOnline && t.lastPollSuccessAt ? `${relative(t.lastPollSuccessAt)}轮询成功` : d.stages.cloud.label, d.stages.cloud.tone === "err" ? "err" : d.stages.cloud.tone === "warn" ? "warn" : null);
    row("#s-ws", c.workspacePath || "未配置");
    const running = m.healthy && t.state === "running";
    const primary = $("#btn-primary");
    primary.dataset.mode = !c.setupDone ? "setup" : running || m.state === "error" || t.state === "error" ? "stop" : "start";
    text(primary.querySelector("span"), { setup: "填写连接设置", stop: "断开连接", start: "连接 ChatGPT" }[primary.dataset.mode]);
    setBtn(primary, d.busy, p.has("startAll") || p.has("stopAll"));
    setBtn($("#btn-secondary"), d.busy || !(m.healthy || m.state === "error") || !c.setupDone, p.has("restartMcp"));
    const noTakeover = !!(s.info.isolated || s.info.multiAccount);
    $("#btn-external").hidden = noTakeover || !(m.healthy && !m.managed);
    $("#btn-external").disabled = noTakeover;
    badge("#mcp-badge", d.mcpBadge); badge("#tunnel-badge", d.tunnelBadge); badge("#cloud-badge", { tone: d.stages.cloud.tone, text: d.stages.cloud.label });
    kv("#mcp-kv", [["工具配置", d.mcp.tools], ["端口", d.mcp.port], ["PID", d.mcp.pid], ["运行来源", d.mcp.source], ["构建版本", d.mcp.build, "mono"], ["构建状态", d.mcp.stale], ["访问认证", d.mcp.auth]]);
    kv("#tunnel-kv", [["本地链路", d.tunnel.readyText], ["云端轮询", d.tunnel.cloudText], ["进程 PID", d.tunnel.pid], ["本地端口", d.tunnel.port], ["运行来源", d.tunnel.source], ["出站路由", d.tunnel.route], ["Tunnel ID", d.tunnel.tunnelId, "mono"]]);
    kv("#cloud-kv", [["云端状态", d.stages.cloud.label], ["最近成功", t.lastPollSuccessAt ? `${hms(t.lastPollSuccessAt)}，${relative(t.lastPollSuccessAt)}` : "—"], ["连接器", `Web Harness ${a.name}`], ...(d.tunnel.errorLine ? [["错误", d.tunnel.errorLine, "err"]] : [])]);
    setBtn($("#btn-mcp-start"), d.busy || m.healthy || !c.setupDone, p.has("startMcp"));
    setBtn($("#btn-mcp-stop"), d.busy || !m.healthy, p.has("stopMcp"));
    setBtn($("#btn-mcp-restart"), d.busy || !(m.healthy || m.state === "error") || !c.setupDone, p.has("restartMcp"));
    setBtn($("#btn-tunnel-start"), d.busy || t.state === "running" || !c.setupDone, p.has("startTunnel"));
    setBtn($("#btn-tunnel-stop"), d.busy || !(t.state === "running" || t.state === "error"), p.has("stopTunnel"));
    renderHistory(s);
    kick();
  }
  function badge(sel, b) { const el = $(sel); el.dataset.tone = b.tone; text(el, b.text); }
  function kv(sel, rows) {
    const dl = typeof sel === "string" ? $(sel) : sel;
    if (dl.children.length !== rows.length * 2) dl.replaceChildren(...rows.flatMap(() => [h("dt"), h("dd")]));
    rows.forEach(([k, v, cls], i) => { text(dl.children[i * 2], k); const dd = dl.children[i * 2 + 1]; dd.className = cls || ""; text(dd, v); dd.title = String(v); });
  }
  // Preserve the original narrative labels; retain canonical tool/call identities as row metadata.
  const outcomeLabel = r => ({ needs_input: "参数待修正", review_rejected: "评审未通过", blocked: r.operationStarted === false ? "未执行" : "调用受阻", execution_error: "失败" }[r.outcomeKind] || "失败");
  const extraOf = r => r.phase !== "running" && r.summary && r.summary !== r.target ? r.summary : "";
  const sentenceOf = r => `${core.describe(r).verb} ${r.target || ""}`.trim() + (r.phase === "failed" ? `，${outcomeLabel(r)}` : "") + (extraOf(r) ? `，${extraOf(r)}` : "");
  function renderHistory(s) {
    const list = [...s.activity].sort((x, y) => y.startedAt - x.startedAt).slice(0, 4);
    const sig = JSON.stringify(list.map(r => [r.id, r.phase, r.ms, r.startedAt, r.tool, r.target, r.summary, r.outcomeKind])) + (s.derived.cloudOnline ? 1 : 0);
    const stamp = r => { const sec = (Date.now() - r.startedAt) / 1000; return sec < 45 ? "刚刚" : relative(r.startedAt); };
    if (ui.lastSig.history === sig) { $$("#history li[data-ts]").forEach(li => text(li.querySelector("time"), stamp({ startedAt: +li.dataset.ts }))); return; }
    const prev = new Set(ui.historyIds || []);
    ui.historyIds = list.map(r => r.id);
    ui.lastSig.history = sig;
    $("#history").replaceChildren(...(list.length ? list.map((r, i) => h("li", { class: `${r.phase === "failed" ? "fail" : r.phase === "running" ? "running" : ""}${i === 0 && ui.lastSig.historyReady && !prev.has(r.id) ? " new" : ""}`, dataset: { ts: r.startedAt, tool: r.tool, call: r.callId || r.id } },
      h("time", null, stamp(r)), h("span", { class: "w", title: sentenceOf(r) }, `${core.describe(r).verb} ${r.target || ""}`.trim(), r.phase === "failed" ? h("span", { class: "result" }, `，${outcomeLabel(r)}`) : null, extraOf(r) ? `，${extraOf(r)}` : ""), h("span", { class: "d" }, r.phase === "running" ? "…" : duration(r.ms)))) : [h("li", { class: "empty" }, s.derived.cloudOnline ? "ChatGPT 还没有调用工具。" : "连接后，ChatGPT 的每一次操作都会写在这里。")]));
    ui.lastSig.historyReady = true;
  }
  core.on("activity", ({ kind, record }) => {
    if (kind === "start") { if (!RM.matches) pulseStart = performance.now(); active.set(1); activeUntil = 0; }
    else if (kind === "end") {
      // Fast calls can finish in the same IPC batch. Keep their real feedback
      // visible for one beat; older runtimes may only report completion.
      if (!RM.matches && active.target === 0) pulseStart = performance.now();
      active.set(1); activeUntil = Date.now() + 1400;
    }
    kick();
    const s = core.snapshot(); renderWorkspace(s); if (ui.view === "logs") renderSpectrum(s);
    // ChatGPT can install or remove Skills itself (install_skill / uninstall_skill); re-read the catalog after it does.
    if (kind === "end" && record && /skill/i.test(record.tool || "") && !/^(load_skill|list_skills)$/.test(record.tool)) setTimeout(() => refreshSkills(), 400);
  });

  function placePop(pop, anchor, side, host) {
    const view = host.getBoundingClientRect(), r = anchor.getBoundingClientRect();
    pop.hidden = false;
    const w = pop.offsetWidth, ph = pop.offsetHeight;
    let x, y;
    if (side === "left") { x = r.left - view.left - w - 22; y = r.top - view.top + r.height / 2 - ph / 2; pop.style.setProperty("--ox", "100%"); pop.style.setProperty("--oy", "50%"); }
    else { x = r.right - view.left + 22; y = r.top - view.top + r.height / 2 - ph / 2; pop.style.setProperty("--ox", "0%"); pop.style.setProperty("--oy", "50%"); if (x + w > view.width) { x = r.left - view.left - w - 22; pop.style.setProperty("--ox", "100%"); } }
    x = Math.max(0, Math.min(view.width - w, x)); y = Math.max(0, Math.min(view.height - ph - 8, y));
    pop.style.left = x + "px"; pop.style.top = y + "px";
    pop.classList.remove("closing"); void pop.offsetWidth; pop.classList.add("opening");
  }
  function togglePop(name, anchor) {
    if (ui.pop === name) return closePop();
    closePop();
    placePop($("#pop-" + name), anchor, "left", $("#view-workspace"));
    ui.pop = name; anchor.setAttribute("aria-expanded", "true");
    $("#pop-" + name).querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }
  function closePop() {
    if (!ui.pop) return;
    const pop = $("#pop-" + ui.pop), name = ui.pop; ui.pop = null;
    $$(".link-row[aria-expanded]").forEach(b => b.removeAttribute("aria-expanded"));
    pop.classList.remove("opening"); pop.classList.add("closing");
    setTimeout(() => { if (ui.pop !== name) { pop.hidden = true; pop.classList.remove("closing"); } }, 180);
  }
  $$(".link-row[data-pop]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); togglePop(b.dataset.pop, b); }));
  document.addEventListener("click", e => { if (ui.pop && !e.target.closest(".pop") && !e.target.closest(".link-row")) closePop(); });

  const run = fn => async (...args) => { try { await fn(...args); } catch (error) { toast(error.message || String(error), "error"); } };
  $("#btn-primary").addEventListener("click", run(async () => {
    const mode = $("#btn-primary").dataset.mode;
    if (mode === "setup") return setView("settings", { pane: "credentials" });
    if (mode === "stop") { if (await confirmBox("断开当前账户？", "MCP Runtime 与 Secure Tunnel 都会停止，进行中的工具调用会中断。", "断开连接")) await A.stopAll(); return; }
    await A.startAll();
  }));
  $("#btn-secondary").addEventListener("click", run(() => A.restartMcp()));
  $("#btn-external").addEventListener("click", run(async () => {
    const info = core.snapshot().info;
    if (info.isolated || info.multiAccount) return;
    if (await confirmBox("接管外部进程？", "将结束占用当前端口的外部 MCP / Tunnel 进程，并由本启动器重新启动。", "接管")) await A.stopExternal();
  }));
  $("#btn-mcp-start").addEventListener("click", run(() => A.startMcp()));
  $("#btn-mcp-stop").addEventListener("click", run(() => A.stopMcp()));
  $("#btn-mcp-restart").addEventListener("click", run(() => A.restartMcp()));
  $("#btn-tunnel-start").addEventListener("click", run(() => A.startTunnel()));
  $("#btn-tunnel-stop").addEventListener("click", run(() => A.stopTunnel()));
  document.addEventListener("click", run(e => { const b = e.target.closest("[data-url]"); if (b) { const u = core.urls(core.snapshot().account.config || {}); return A.openExternal(u[b.dataset.url] || b.dataset.url); } }));

  /* ===================== 能力库: an index of lights ===================== */
  const SHIFTS = [0, .07, -.07, .14, -.12, .2, -.17, .1];
  const shiftOf = id => { let x = 7; for (const ch of String(id)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return SHIFTS[x % SHIFTS.length]; };
  function keyed(container, items, keyOf, create, update, empty) {
    const old = new Map($$(":scope > [data-row]", container).map(el => [el.dataset.row, el]));
    $$(":scope > .empty", container).forEach(el => el.remove());
    const els = items.map(item => { const k = keyOf(item); let el = old.get(k); if (!el) { el = create(item); el.dataset.row = k; el._fresh = true; } else { old.delete(k); el._fresh = false; } update(el, item); return el; });
    old.forEach(el => el.remove());
    els.forEach((el, i) => { if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null); });
    if (!items.length && empty) container.append(empty());
  }
  // Re-read the catalog from disk. Manual refreshes report what changed; automatic ones stay quiet.
  let skillsRefreshing = null, lastSkillsSync = 0;
  function refreshSkills({ manual = false } = {}) {
    if (skillsRefreshing) return skillsRefreshing;
    const before = new Set(((core.snapshot().catalog || {}).installed || []).map(x => x.id));
    const btn = $("#btn-skills-refresh"); btn.setAttribute("aria-busy", "true");
    skillsRefreshing = (async () => {
      try {
        const fresh = await A.refreshCatalog(), now = ((fresh && fresh.installed) || []).map(x => x.id);
        lastSkillsSync = Date.now();
        if (manual) {
          const added = now.filter(id => !before.has(id)), removed = [...before].filter(id => !now.includes(id));
          toast(added.length || removed.length ? `能力库已刷新：${[added.length ? `新增 ${added.join("、")}` : "", removed.length ? `移除 ${removed.join("、")}` : ""].filter(Boolean).join("，")}。` : "能力库已是最新。");
        }
      } catch (err) { if (manual && err.code !== "STALE") toast(err.message, "error"); }
      finally { btn.setAttribute("aria-busy", "false"); skillsRefreshing = null; }
    })();
    return skillsRefreshing;
  }
  $("#btn-skills-refresh").addEventListener("click", () => refreshSkills({ manual: true }));
  const autoRefreshSkills = () => { if (ui.view === "skills" && !document.hidden && Date.now() - lastSkillsSync > 2500) refreshSkills(); };
  addEventListener("focus", autoRefreshSkills);
  document.addEventListener("visibilitychange", autoRefreshSkills);
  setInterval(() => { if (Date.now() - lastSkillsSync > 25000) autoRefreshSkills(); }, 5000);
  async function toggleSkill(id, row, next) {
    if (row.classList.contains("has-error")) return;
    const b = row.querySelector(".switch"); travel(b); sw(b, next);
    row.dataset.on = String(next); orbLook(row.querySelector(".sk-orb"), { light: next ? 1 : 0, flash: next });
    try { await A.setSkillEnabled("installed", id, next); } catch (err) { toast(err.message, "error"); ui.lastSig.skills = null; renderSkills(core.snapshot()); }
  }
  function skillRow(x) {
    const row = h("li", { class: "sk-row" });
    const orb = h("span", { class: "sk-orb", "data-orb": "skill", "aria-hidden": "true", onclick: () => toggleSkill(x.id, row, row.dataset.on !== "true") });
    orbLook(orb, { shift: shiftOf(x.id), light: 0, jump: true });
    const s = switchEl(false, `启用 ${x.id}`, v => toggleSkill(x.id, row, v), "i-" + x.id);
    s.addEventListener("click", e => e.stopImmediatePropagation(), { capture: false });
    row.append(orb, h("div", { class: "sk-text" }, h("b"), h("p"), h("span", { class: "meta" })), s,
      h("button", { class: "icon-btn", type: "button", "aria-label": `${x.id} 详情`, dataset: { key: "m-" + x.id }, onclick: e => { e.stopPropagation(); openSkillPop("installed", x.id, e.currentTarget); } }, icon(I.more)));
    return row;
  }
  function updateSkillRow(row, x, q) {
    const v = x.enabled !== false, broken = !!x.error;
    row.dataset.on = String(v && !broken);
    row.classList.toggle("has-error", broken);
    const toggle = row.querySelector(".switch"); sw(toggle, v); toggle.disabled = broken;
    toggle.title = broken ? "SKILL.md 无法读取，修复后再启用" : "";
    orbLook(row.querySelector(".sk-orb"), { light: v && !broken ? 1 : 0, jump: !ui.lastSig.skillsReady });
    text(row.querySelector("b"), x.id);
    text(row.querySelector("p"), x.error || x.description || "—");
    const meta = row.querySelector(".meta"); text(meta, [x.version && x.version !== "—" ? "v" + x.version : null, x.path].filter(Boolean).join(" · ")); meta.title = x.path || "";
    row.classList.toggle("filtered", !!q && !(x.id + " " + (x.description || "") + " " + (x.path || "")).toLowerCase().includes(q));
    if (row._fresh && ui.lastSig.skillsReady && !RM.matches) { row.classList.add("born"); orbLook(row.querySelector(".sk-orb"), { flash: true }); setTimeout(() => row.classList.remove("born"), 950); }
  }
  function renderSkills(s) {
    const cat = s.catalog || {};
    const sig = JSON.stringify([cat, ui.skillQuery]);
    if (ui.lastSig.skills === sig) return; ui.lastSig.skills = sig;
    let engines = 0;
    for (const name of ["computerUse", "browserUse"]) {
      const e = cat[name] || {}, row = $("#engine-" + name), b = row.querySelector(".switch"), v = !!e.enabled;
      sw(b, v); b.disabled = e.available === false; row.dataset.on = String(v);
      orbLook(row.querySelector(".engine-orb"), { light: v ? 1 : 0, shift: name === "computerUse" ? -.1 : .12, jump: !ui.lastSig.skillsReady });
      text($("#state-" + name), e.available === false ? "运行时缺失，无法启用" : "");
      $("#state-" + name).hidden = e.available !== false;
      if (v) engines++;
    }
    const q = ui.skillQuery.trim().toLowerCase(), installed = cat.installed || [];
    const matches = installed.filter(x => !q || (x.id + " " + (x.description || "") + " " + (x.path || "")).toLowerCase().includes(q));
    text($("#skills-count"), q ? `${matches.length}/${installed.length}` : installed.length);
    keyed($("#installed-list"), installed, x => x.id, skillRow, (el, x) => updateSkillRow(el, x, q));
    const ro = [...(cat.project || []).map(x => [x, "项目"]), ...(cat.builtin || []).map(x => [x, "内置"])];
    keyed($("#readonly-list"), ro, ([x, tag]) => tag + ":" + x.id, ([x, tag]) => {
      const orb = h("span", { class: "sk-orb", "data-orb": "ro", "aria-hidden": "true" }); orbLook(orb, { frost: 1, light: 1, jump: true });
      return h("li", { class: "sk-row" }, orb, h("div", { class: "sk-text" }, h("b", null, x.id), h("p")), h("span", { class: "tag" }, tag));
    }, (el, [x]) => { text(el.querySelector("p"), x.description || "—"); el.classList.toggle("filtered", !!q && !(x.id + " " + (x.description || "")).toLowerCase().includes(q)); }, () => h("li", { class: "empty" }, "暂无"));
    text($("#registry-path"), cat.configPath || "profiles/plugins.json");
    const ext = cat.external || [];
    keyed($("#external-list"), ext, x => x.id, x => h("div", { class: "ext-row" },
      h("span", { class: "ext-ring", "aria-hidden": "true" }),
      h("div", { style: "min-width:0" }, h("b", null, x.id, h("span", { class: "unsaved", hidden: true }, "未保存")), h("code")),
      switchEl(x.enabled !== false, `启用 ${x.id}`, v => { try { A.setExternalEnabled(x.id, v); } catch (err) { toast(err.message, "error"); } }, "e-" + x.id),
      h("button", { class: "icon-btn", type: "button", "aria-label": `移除 ${x.id}`, title: "移除", dataset: { key: "r-" + x.id }, onclick: () => A.removeExternal(x.id) }, icon(I.close))),
      (el, x) => { el.dataset.on = String(x.enabled !== false); el.querySelector(".unsaved").hidden = !x.unsaved; const c = el.querySelector("code"); text(c, x.path); c.title = x.path; sw(el.querySelector(".switch"), x.enabled !== false); },
      () => h("div", { class: "empty" }, "没有外部注册。"));
    text($("#external-dirty"), ext.some(x => x.unsaved) ? "有未保存的修改" : `${ext.length} 项，已保存`);
    const lit = installed.filter(x => x.enabled !== false).length;
    fill($("#skills-live"), h("em", null, lit), " 个 Skill 正在发光，", h("em", null, engines), " 个交互引擎已开启", ext.length ? ["，另有 ", h("em", null, ext.length), " 个外部注册"] : null, "。");
    ui.lastSig.skillsReady = true;
    if (ui.skillPop) refreshSkillPop();
    kick();
  }
  async function uninstall(id) { if (await confirmBox(`卸载 ${id}？`, "会删除该 Skill 的本地目录。已打开的 MCP 会话需要新建后才会生效。", "卸载")) { try { closeSkillPop(); await A.uninstallSkill(id); } catch (err) { toast(err.message, "error"); } } }
  function openSkillPop(kind, id, anchor) {
    if (ui.skillPop && ui.skillPop.id === id) return closeSkillPop();
    ui.skillPop = { kind, id };
    refreshSkillPop();
    placePop($("#skill-pop"), anchor, "left", $("#view-skills"));
    $("#skill-pop").querySelector("button")?.focus({ preventScroll: true });
  }
  function refreshSkillPop() {
    const { id } = ui.skillPop, x = ((core.snapshot().catalog || {}).installed || []).find(s => s.id === id);
    if (!x) return closeSkillPop();
    const v = x.enabled !== false;
    text($("#skill-pop-title"), id); text($("#skill-pop-sub"), `已安装${x.version && x.version !== "—" ? " · v" + x.version : ""} · ${v ? "已启用" : "已停用"}`);
    text($("#skill-pop-desc"), x.error || x.description || "—");
    kv("#skill-pop-kv", [["状态", v ? "已启用，新建 MCP 会话后可用" : "已停用"], ["版本", x.version || "—"], ["位置", x.path || "—", "mono"]]);
    fill($("#skill-pop-actions"),
      h("button", { class: "btn small", type: "button", onclick: () => { const row = $(`#installed-list [data-row="${CSS.escape(id)}"]`); if (row) toggleSkill(id, row, !v); } }, v ? "停用" : "启用"),
      x.path ? h("button", { class: "ghost", type: "button", onclick: () => A.copyText(x.path, "路径") }, icon(I.copy), "复制路径") : null,
      h("button", { class: "ghost warn", type: "button", onclick: () => uninstall(id) }, icon(I.trash), "卸载"));
  }
  function closeSkillPop() {
    if (!ui.skillPop) return; ui.skillPop = null;
    const pop = $("#skill-pop"); pop.classList.remove("opening"); pop.classList.add("closing");
    setTimeout(() => { if (!ui.skillPop) { pop.hidden = true; pop.classList.remove("closing"); } }, 180);
  }
  document.addEventListener("click", e => { if (ui.skillPop && !e.target.closest("#skill-pop") && !e.target.closest(".sk-row .icon-btn")) closeSkillPop(); });
  $$(".engine .switch").forEach(b => b.addEventListener("click", () => {
    const next = b.getAttribute("aria-checked") !== "true", row = b.closest(".engine"); travel(b); sw(b, next); row.dataset.on = String(next);
    orbLook(row.querySelector(".engine-orb"), { light: next ? 1 : 0, flash: next });
    Promise.resolve().then(() => A.setEngine(b.dataset.engine, next)).catch(err => { toast(err.message, "error"); ui.lastSig.skills = null; renderSkills(core.snapshot()); });
  }));
  $("#skill-search").addEventListener("input", e => { ui.skillQuery = e.target.value; renderSkills(core.snapshot()); });
  async function beginInstall(kind, anchor) {
    try {
      const src = await A.inspectSource(kind);
      if (!src) return;
      ui.install = src;
      text($("#install-title"), src.id || "Skill");
      kv("#install-meta", [["来源", kind === "zip" ? "zip 压缩包" : "目录"], ["位置", src.root || "—", "mono"], ["版本", src.version || "—"], ["说明", src.description || "—"]]);
      $("#install-id").value = src.id || "";
      $("#install-warnings").replaceChildren(...(src.warnings || []).map(w => h("li", null, w)));
      const sheet = $("#install-sheet"), view = $("#view-skills").getBoundingClientRect(), r = anchor.getBoundingClientRect();
      sheet.hidden = false;
      sheet.style.left = Math.max(8, Math.min(view.width - sheet.offsetWidth - 8, r.right - view.left - sheet.offsetWidth)) + "px";
      sheet.style.top = Math.max(8, Math.min(view.height - sheet.offsetHeight - 8, r.bottom - view.top + 12)) + "px";
      sheet.style.setProperty("--ox", "100%"); sheet.style.setProperty("--oy", "0%");
      sheet.classList.remove("closing"); void sheet.offsetWidth; sheet.classList.add("opening");
      $("#install-id").focus();
    } catch (err) { toast(err.message, "error"); }
  }
  function hideInstall(discard) { const sheet = $("#install-sheet"); if (sheet.hidden) return; if (discard && ui.install) Promise.resolve(A.discardSource(ui.install)).catch(err => toast(err.message, "error")); ui.install = null; sheet.classList.add("closing"); setTimeout(() => { sheet.hidden = true; sheet.classList.remove("closing"); }, 180); }
  $("#btn-install-folder").addEventListener("click", e => beginInstall("folder", e.currentTarget));
  $("#btn-install-zip").addEventListener("click", e => beginInstall("zip", e.currentTarget));
  $("#btn-install-cancel").addEventListener("click", () => hideInstall(true));
  $("#btn-install-confirm").addEventListener("click", async () => {
    const b = $("#btn-install-confirm"); setBtn(b, false, true);
    try { await A.installSkill($("#install-id").value.trim(), ui.install); hideInstall(false); } catch (err) { toast(err.message, "error"); } finally { setBtn(b, false, false); }
  });
  $("#external-form").addEventListener("submit", e => {
    e.preventDefault();
    try { A.addExternal($("#ext-name").value, $("#ext-path").value); $("#ext-name").value = ""; $("#ext-path").value = ""; $("#ext-path").closest(".inline").classList.remove("invalid"); }
    catch (err) { toast(err.message, "error"); $("#ext-path").closest(".inline").classList.add("invalid"); }
  });
  $("#btn-ext-pick").addEventListener("click", async () => { try { const p = await A.pickSkillFile(); if (p) { $("#ext-path").value = p; $("#ext-path").focus(); } } catch (err) { toast(err.message, "error"); } });
  $("#btn-ext-save").addEventListener("click", async () => { const b = $("#btn-ext-save"); setBtn(b, false, true); try { await A.saveExternal(); } catch (err) { toast(err.message, "error"); } finally { setBtn(b, false, false); } });

  /* ===================== 事件日志: spectrum + transcript ===================== */
  const SPAN = 30 * 60000, NB = 60, BIN = SPAN / NB;
  // the same stops as the CSS --iris gradient: blue, violet, pink, peach
  const IRIS = [[0, [74, 120, 255]], [.42, [143, 92, 255]], [.78, [255, 95, 168]], [1, [255, 154, 90]]];
  const irisAt = t => { t = Math.max(0, Math.min(1, t)); let k = 1; while (k < IRIS.length - 1 && IRIS[k][0] < t) k++; const [t0, a] = IRIS[k - 1], [t1, b] = IRIS[k], f = (t - t0) / (t1 - t0); return a.map((v, j) => Math.round(v + (b[j] - v) * f)); };
  const rgb = c => `rgb(${c.join(",")})`;
  function renderSpectrum(s) {
    const now = Date.now(), counts = new Array(NB).fill(0), fails = new Array(NB).fill(0);
    let running = false;
    for (const r of s.activity) {
      const age = now - r.startedAt; if (age < 0 || age > SPAN) continue;
      const i = Math.min(NB - 1, Math.floor((SPAN - age) / BIN)); counts[i]++; if (r.phase === "failed") fails[i]++; if (r.phase === "running") running = true;
    }
    const max = Math.max(2, ...counts), host = $("#spec-bars");
    if (host.children.length !== NB) host.replaceChildren(...counts.map(() => h("span", { class: "spec-bar" })));
    counts.forEach((c, i) => {
      const el = host.children[i], v = Math.sqrt(c / max);
      el.style.setProperty("--v", v.toFixed(3));
      el.style.setProperty("--c", c ? rgb(irisAt(i / (NB - 1))) : "");
      el.classList.toggle("zero", !c); el.classList.toggle("fail", fails[i] > 0); el.classList.toggle("hot", v > .66); el.classList.toggle("now", running && i === NB - 1);
    });
    const recent = s.activity.filter(r => r.startedAt > now - SPAN), f = recent.filter(r => r.phase === "failed").length;
    const real = core.mode !== "preview";
    fill($("#logs-live"), recent.length ? [real ? "近 30 分钟，发生了 " : "近 30 分钟，ChatGPT 调用了 ", h("em", null, recent.length), real ? " 次工具调用" : " 次工具", f ? ["，其中 ", h("em", null, f), " 次未完成"] : recent.some(r => r.phase === "running") ? "，仍有调用进行中" : "，全部成功", "。"] : s.derived.cloudOnline ? (real ? "已连接，尚无工具调用记录。" : "已连接。ChatGPT 还没有调用工具。") : "服务未连接，这里还很安静。");
  }
  const spec = $("#spectrum");
  spec.addEventListener("pointermove", e => {
    const r = spec.getBoundingClientRect(), x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), i = Math.min(NB - 1, Math.floor(x * NB));
    const t1 = Date.now() - SPAN + i * BIN, t2 = t1 + BIN, calls = core.snapshot().activity.filter(a => a.startedAt >= t1 && a.startedAt < t2), f = calls.filter(a => a.phase === "failed").length;
    const tip = $("#spec-tip"); tip.hidden = false; tip.style.left = (x * r.width) + "px";
    text(tip, `${hms(t1).slice(0, 5)} · ${calls.length ? `${calls.length} 次调用${f ? `，${f} 次未完成` : ""}` : "没有调用"}`);
  });
  spec.addEventListener("pointerleave", () => { $("#spec-tip").hidden = true; });
  spec.addEventListener("click", e => {
    const r = spec.getBoundingClientRect(), t1 = Date.now() - SPAN + Math.floor((e.clientX - r.left) / r.width * NB) * BIN;
    const target = $$("#log-view [data-ts]").find(el => +el.dataset.ts >= t1);
    if (target) { ui.autoscroll = false; sw($("#log-autoscroll"), false); target.scrollIntoView({ block: "center", behavior: RM.matches ? "auto" : "smooth" }); target.classList.remove("fresh"); void target.offsetWidth; target.classList.add("fresh"); }
  });
  function markText(el, value, q) {
    el.replaceChildren(); if (!q) { el.textContent = value; return; }
    const lower = value.toLowerCase(), ql = q.toLowerCase(); let i = 0, j;
    while ((j = lower.indexOf(ql, i)) !== -1) { if (j > i) el.append(value.slice(i, j)); el.append(h("mark", null, value.slice(j, j + q.length))); i = j + q.length; }
    if (i < value.length) el.append(value.slice(i));
  }
  // A call still in flight reports once a minute (MCP stdout or the Admin feed); tell how long it has run.
  function runningReport(text) {
    let m = /^\[MCP\] \[running\] tools\/call ([\w.-]+)(?: — (.*?))? (\d+)ms(?: session=\S+)?(?: conv=[0-9a-f]+)?$/.exec(text);
    if (m) return { tool: m[1], target: m[2] || "", ms: +m[3] };
    m = /^\[mcp\] tools\/call ([\w.-]+) running (\d+)ms(?: \S+=\S+)*(?: — (.*))?$/.exec(text);
    return m ? { tool: m[1], target: m[3] || "", ms: +m[2] } : null;
  }
  function storyItems(entries) {
    const items = [], calls = new Map(); let open = null;
    for (const e of entries) {
      if (/^\[TOOL DETAIL\]/.test(e.text)) continue;
      const invocation = HarnessCore.invocationFromLine(e.text);
      if (invocation) {
        let item = calls.get(invocation.callId);
        if (!item) {
          item = { kind: "call", callId: invocation.callId, canonical: false, e, lines: [], tool: invocation.tool, target: invocation.target, elapsed: 0, result: null };
          calls.set(invocation.callId, item); items.push(item);
        }
        item.lines.push(e);
        // HTTP diagnostics can supply a fallback, but the actual invocation's
        // lifecycle owns its status and elapsed time once present.
        if (invocation.transport && item.canonical) continue;
        if (!invocation.transport && !item.canonical) { item.canonical = true; item.e = e; item.result = null; }
        if (invocation.phase === "running" && item.result) continue;
        item.tool = invocation.tool; item.target = invocation.target || item.target;
        item.elapsed = invocation.ms;
        if (invocation.phase !== "running") item.result = { ...invocation, ok: invocation.phase === "done", summary: invocation.summary === invocation.target ? "" : invocation.summary };
        continue;
      }
      const completed = HarnessCore.activityFromLogs([e]).find(record => record.phase !== "running");
      if (completed) {
        items.push({ kind: "call", e, lines: [e], tool: completed.tool, target: completed.target,
          result: { ...completed, summary: completed.summary === completed.target ? "" : completed.summary } });
        continue;
      }
      const t = /^\[tool\]\s+([\w.-]+)\s*(?:·\s*(.*))?$/.exec(e.text);
      if (t) { open = { kind: "call", e, lines: [e], tool: t[1], target: t[2] || "", result: null }; items.push(open); continue; }
      const r = /^\[result\]\s+(Completed|Failed)\s+in\s+(\d+)\s*ms\s*(?:·\s*(.*))?$/i.exec(e.text);
      if (r && open && !open.result) { open.result = { ok: /completed/i.test(r[1]), ms: +r[2], summary: r[3] || "" }; open.lines.push(e); continue; }
      const live = runningReport(e.text);
      if (live) { items.push({ kind: "sys", e, lines: [e], tag: "运行中", msg: `${live.tool} 已运行 ${duration(live.ms)}${live.target ? ` · ${live.target}` : ""}` }); continue; }
      const m = /^\[([\w-]+)\]\s*(.*)$/.exec(e.text);
      items.push({ kind: "sys", e, lines: [e], tag: m ? m[1] : "", msg: m ? m[2] : e.text });
    }
    return items;
  }
  const itemLevel = it => it.kind === "call" ? (it.result && !it.result.ok ? "error" : "info") : it.e.level;
  function itemPasses(it) {
    const q = ui.query.trim().toLowerCase();
    if (ui.level !== "all" && itemLevel(it) !== ui.level) return false;
    if (ui.hideHealth && it.lines.every(l => l.health)) return false;
    return !q || it.lines.some(l => (l.time + " " + l.text).toLowerCase().includes(q));
  }
  function evEl(it) {
    const q = ui.query.trim();
    if (it.kind === "call") {
      const res = it.result, phase = !res ? "running" : res.ok ? "done" : "failed";
      const pct = res && res.ms != null ? Math.max(4, Math.min(100, Math.log10(Math.max(1, res.ms)) / 4 * 100)) : 0;
      const target = h("code"); markText(target, it.target || it.tool, q);
      const r = h("span", { class: "res" }); markText(r, !res ? "，进行中…" : res.ok ? (res.summary ? `，${res.summary}` : "，完成") : `，${outcomeLabel(res)}${res.summary ? `：${res.summary}` : ""}`, q);
      return h("div", { class: `ev ev-call call ${phase}`, dataset: { entry: it.e.seq, call: it.callId, tool: it.tool, ts: it.e.ts, level: itemLevel(it), outcome: res?.outcomeKind }, title: it.lines.map(l => `${l.time} ${l.text}`).join("\n") },
        h("span", { class: "t" }, it.e.time), h("span", { class: "dot" }),
        h("p", { class: "say" }, h("b", null, core.describe({ tool: it.tool }).verb), target, r),
        h("div", { class: "dur" }, h("span", { class: "bar" }, h("i", { style: `--p:${pct.toFixed(0)}%` })), h("span", null, res ? (res.ms == null ? "未记录" : duration(res.ms)) : it.elapsed > 0 ? `已运行 ${duration(it.elapsed)}` : "…")));
    }
    const msg = h("span"); markText(msg, it.msg, q);
    return h("div", { class: "ev sys", dataset: { entry: it.e.seq, ts: it.e.ts, level: it.e.level } }, h("span", { class: "t" }, it.e.time), h("span", { class: "dot" }), h("p", { class: "say" }, it.tag ? h("span", { class: "tag" }, it.tag) : null, msg));
  }
  function lineEl(e) { const row = h("div", { class: "line", dataset: { level: e.level, entry: e.seq, ts: e.ts } }, h("span", { class: "t" }, e.time), h("span", { class: "l" }), h("span", { class: "x" })); markText(row.lastChild, e.text, ui.query.trim()); return row; }
  let logTimer = 0, lastLogRender = 0;
  function scheduleLogs() { if (logTimer) return; logTimer = setTimeout(() => { logTimer = 0; renderLogs(true); }, Math.max(0, 220 - (performance.now() - lastLogRender))); }
  function renderLogs(live) {
    if (ui.view !== "logs") return;
    lastLogRender = performance.now();
    const s = core.snapshot(), all = s.logs[ui.source] || [], view = $("#log-view");
    const prevIds = live ? new Set($$("[data-entry]", view).map(el => el.dataset.entry)) : null;
    view.classList.toggle("raw", ui.logMode === "raw");
    let nodes = [];
    if (ui.logMode === "raw") nodes = core.filterLogs(all, ui).slice(-3000).map(lineEl);
    else {
      const items = storyItems(all).filter(itemPasses), shown = items.slice(-ui.storyLimit);
      if (items.length > shown.length) nodes.push(h("div", { class: "more-row" }, h("button", { class: "ghost", type: "button", onclick: () => { ui.storyLimit += 1200; renderLogs(); } }, `显示更早的 ${items.length - shown.length} 条`)));
      let minute = "";
      for (const it of shown) { const mm = it.e.time.slice(0, 5); if (mm !== minute) { minute = mm; nodes.push(h("div", { class: "minute", "aria-hidden": "true" }, mm)); } nodes.push(evEl(it)); }
    }
    if (prevIds && !RM.matches) nodes.forEach(n => { if (n.dataset.entry && !prevIds.has(n.dataset.entry)) n.classList.add("fresh"); });
    view.replaceChildren(...(nodes.length ? nodes : [h("div", { class: "empty-state" }, all.length ? "没有符合条件的记录。" : "这里还没有记录。")]));
    if (ui.autoscroll) view.scrollTop = view.scrollHeight;
    logMeta(s);
  }
  function logMeta(s) {
    const openLabel = ui.source === "launcher" ? "打开日志目录" : "打开日志文件";
    $("#btn-open-log").title = openLabel;
    $("#btn-open-log").setAttribute("aria-label", openLabel);
    for (const k of ["mcp", "tunnel", "launcher"]) text($("#count-" + k), (s.logs[k] || []).length);
    const all = s.logs[ui.source] || [], matches = ui.logMode === "raw" ? core.filterLogs(all, ui).length : storyItems(all).filter(itemPasses).length;
    const shown = Math.min(matches, ui.logMode === "raw" ? 3000 : ui.storyLimit);
    text($("#log-summary"), `显示 ${shown} 条${matches > shown ? ` · 共 ${matches} 条匹配` : ""}`);
    $("#log-summary").title = `当前来源 ${all.length} 行，界面最多保留 3000 行。`;
  }
  core.on("log", e => {
    if (ui.view !== "logs") return;
    if (e.source !== ui.source) return logMeta(core.snapshot());
    if (ui.logMode === "raw") {
      logMeta(core.snapshot());
      if (!core.filterLogs([e], ui).length) return;
      const view = $("#log-view"); view.querySelector(".empty-state")?.remove();
      const row = lineEl(e); if (!RM.matches) row.classList.add("fresh"); view.append(row);
      while (view.children.length > 3000) view.firstChild.remove();
      if (ui.autoscroll) view.scrollTop = view.scrollHeight;
    } else scheduleLogs();
  });
  $$("#seg-source button").forEach(b => b.addEventListener("click", () => { ui.source = b.dataset.source; $$("#seg-source button").forEach(x => x.setAttribute("aria-selected", String(x === b))); placeIndicators(); renderLogs(); }));
  $$("#seg-level button").forEach(b => b.addEventListener("click", () => { ui.level = b.dataset.level; $$("#seg-level button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); placeIndicators(); renderLogs(); }));
  $$("#seg-mode button").forEach(b => b.addEventListener("click", () => { ui.logMode = b.dataset.mode; $$("#seg-mode button").forEach(x => x.setAttribute("aria-selected", String(x === b))); placeIndicators(); renderLogs(); }));
  $("#log-search").addEventListener("input", e => { ui.query = e.target.value; renderLogs(); });
  for (const [id, key] of [["#log-hide-health", "hideHealth"], ["#log-autoscroll", "autoscroll"]]) $(id).addEventListener("click", e => { const b = e.currentTarget; ui[key] = b.getAttribute("aria-checked") !== "true"; travel(b); sw(b, ui[key]); renderLogs(); });
  $("#btn-copy-log").addEventListener("click", run(() => { const rows = core.filterLogs(core.snapshot().logs[ui.source] || [], ui); return A.copyText(rows.map(r => `${r.time} ${r.text}`).join("\n"), ` ${rows.length} 行日志`); }));
  $("#btn-open-log").addEventListener("click", run(() => A.openLogFile(ui.source)));
  $("#btn-open-logs-dir").addEventListener("click", run(() => A.openLogsFolder()));
  $("#btn-open-runtime").addEventListener("click", run(() => A.openRuntime()));
  $("#btn-clear-log").addEventListener("click", async () => { if (!(await confirmBox("清空当前来源？", "只清空界面里的日志缓冲，磁盘上的日志文件不会删除。", "清空"))) return; try { await A.clearLogs(ui.source); renderLogs(); renderSpectrum(core.snapshot()); toast("当前来源的日志缓冲已清空。"); } catch (err) { toast(err.message, "error"); } });

  /* ===================== 设置: written as sentences ===================== */
  const F = Object.fromEntries(core.settings.flatMap(s => s.fields).map(f => [f.key, f]));
  let chapterNavigation = null;
  const CHAPTERS = [["credentials", "连接"], ["workspace", "工作区"], ["network", "端口"], ["tools", "工具集"], ["proxy", "出站代理"], ["desktop", "桌面"], ["reminder", "提醒"], ["conversations", "会话标签"], ["appearance", "外观"], ["maintenance", "维护"], ["guide", "接入指引"]];
  // inline inputs grow with what they hold, like words in a sentence
  const fit = input => { if (input.inputMode === "numeric") return; const n = Math.max((input.value || "").length, (input.placeholder || "").length * .9, input.dataset.min ? +input.dataset.min : 3); input.style.width = `calc(${Math.min(n, +(input.dataset.max || 60))}ch + 6px)`; };
  function inline(key, o = {}) {
    const f = F[key];
    const input = h("input", { id: "f-" + key, type: o.type || (f.type === "password" ? "password" : "text"), placeholder: o.placeholder ?? (f.placeholder || ""), spellcheck: "false", "aria-label": f.label, inputmode: o.numeric ? "numeric" : null, maxlength: o.numeric ? "5" : null, dataset: { min: o.min || "", max: o.max || "" } });
    input.addEventListener("input", () => { if (o.numeric) input.value = input.value.replace(/\D+/g, ""); fit(input); setDraft(key, o.numeric ? (input.value === "" ? "" : Number(input.value)) : input.value, true); });
    if (o.numeric) input.addEventListener("keydown", e => { if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return; e.preventDefault(); const v = Math.max(1024, Math.min(65535, (Number(input.value) || 1024) + (e.key === "ArrowUp" ? 1 : -1))); input.value = v; setDraft(key, v, true); });
    return h("label", { class: "inline" + (o.cls ? " " + o.cls : ""), dataset: { key } }, input);
  }
  function chips(key, id, options) {
    const ind = h("span", { class: "seg-ind", "aria-hidden": "true" });
    const box = h("span", { class: "chips", id, role: "radiogroup", "aria-label": F[key].label, dataset: { key } }, ind, ...options.map(([v, label, small]) => h("button", { type: "button", role: "radio", "aria-checked": "false", dataset: { value: v }, onclick: () => setDraft(key, v) }, label, small ? h("small", null, small) : null)));
    return { box, ind };
  }
  function toggleLine(key, cls = "") {
    const b = switchEl(false, F[key].label, v => setDraft(key, v), "s-" + key); b.id = "f-" + key;
    return h("div", { class: "toggle-line " + cls, dataset: { key } }, b, h("span", null, F[key].label, "。"));
  }
  function chapter(id, title, kids, tag) { return h("section", { class: "chapter", id: "ch-" + id, dataset: { ch: id } }, h("p", { class: "eyebrow" }, title, tag ? h("span", { class: "tag" }, tag) : null), ...kids); }
  function buildSettings() {
    const form = $("#setup-form");
    const keyInput = inline("apiKey", { cls: "mono", min: 18, max: 40, placeholder: "sk-…" });
    const showKey = h("button", { class: "ghost", type: "button", onclick: e => { const i = $("#f-apiKey"); const show = i.type === "password"; i.type = show ? "text" : "password"; e.currentTarget.textContent = show ? "隐藏" : "显示"; } }, "显示");
    const tools = chips("toolProfile", "tool-chips", [["slim", "精简"], ["full", "全部"]]);
    const proxy = chips("tunnelProxyMode", "proxy-chips", [["auto", "自动选择代理"], ["direct", "直连"], ["custom", "使用代理"]]);
    const proxyUrl = inline("tunnelProxyUrl", { cls: "mono", min: 18, max: 34 });
    const proxyTail = h("span", { id: "proxy-tail", hidden: true }, " ", proxyUrl);
    const themeInd = h("span", { class: "seg-ind", "aria-hidden": "true" });
    const themeChips = h("span", { class: "chips", id: "theme-chips", role: "radiogroup", "aria-label": "界面外观" }, themeInd,
      ...[["system", "跟随系统"], ["light", "浅色"], ["dark", "夜间"]].map(([v, label]) => h("button", { type: "button", role: "radio", "aria-checked": String(theme.choice === v), dataset: { value: v }, onclick: () => applyTheme(v) }, label)));
    const remindInd = h("span", { class: "seg-ind", "aria-hidden": "true" });
    const remindChips = h("span", { class: "chips", id: "remind-chips", role: "radiogroup", "aria-label": "空档提醒" }, remindInd,
      ...[[5, "5 分钟后提醒"], [10, "10 分钟后提醒"], [15, "15 分钟后提醒"], [0, "不提醒"]].map(([v, label]) => h("button", { type: "button", role: "radio", "aria-checked": "false", dataset: { value: String(v) }, onclick: () => setReminder(v) }, label)));
    const soundPicker=h("select",{id:"sound-choice","aria-label":"消息通知音",onchange:async e=>{
      soundPicker.disabled=true;soundPicker._auraChoice.sync();
      try { await A.selectNotificationSound(e.target.value);toast("提示音已保存。"); }
      finally { soundPicker.disabled=false;soundPicker._auraChoice.sync();await refreshSoundControls(); }
    }},SOUND_LABELS.map(([id,label])=>h("option",{value:id,disabled:id==="custom"},label)));
    const soundChoice=choice(soundPicker,"通知提示音");
    const volumeSlider=h("input",{id:"sound-volume",type:"range",min:"0",max:"100",step:"10","aria-label":"通知音量",onchange:async e=>{
      try { await A.setNotificationVolume(Number(e.target.value)); } finally { await refreshSoundControls(); }
    },oninput:e=>{
      text($("#sound-volume-value"),e.target.value+"%");e.target.style.setProperty("--volume",e.target.value+"%");
    }});
    const soundFile=h("input",{id:"sound-file",type:"file",accept:".wav,.mp3,audio/wav,audio/mpeg",hidden:true,onchange:async e=>{
      try {await importCustomSound(e.target.files?.[0]);}
      finally{e.target.value="";}
    }});
    form.append(
      chapter("credentials", "连接", [
        h("p", { class: "say-line" }, "这个账户通过 Tunnel ", inline("tunnelId", { cls: "mono", min: 24, max: 44 }), " 接入 ChatGPT，"),
        h("p", { class: "say-line" }, h("span", { id: "key-lead" }, "Runtime API Key 是 "), keyInput, "。"),
        h("p", { class: "say-help" }, showKey, h("button", { class: "text-link", type: "button", onclick: () => A.openExternal(F.tunnelId.link[1]) }, "获取 Tunnel ID", icon(I.open)), h("button", { class: "text-link", type: "button", onclick: () => A.openExternal(F.apiKey.link[1]) }, "获取 Runtime API Key", icon(I.open)), h("button", { class: "text-link", type: "button", id: "btn-settings-import", onclick: openAccountImport }, "从旧版读取账户")),
        h("p", { class: "say-help", id: "setup-reuse", hidden: true }, h("span", { id: "setup-reuse-text" }), h("button", { class: "text-link", type: "button", id: "btn-setup-reuse" }, "切回已有账户"))]),
      chapter("workspace", "工作区", [
        h("p", { class: "say-line" }, "ChatGPT 在 ", inline("workspacePath", { cls: "mono", min: 16, max: 46 }), " 里工作。"),
        h("p", { class: "say-help" }, h("button", { class: "ghost strong", type: "button", onclick: async () => { try { const p = await A.pickFolder($("#f-workspacePath").value); if (p) { const i = $("#f-workspacePath"); i.value = p; fit(i); setDraft("workspacePath", p, true); } } catch (err) { toast(err.message, "error"); } } }, icon(I.folder), "选择目录"))]),
      chapter("network", "端口", [
        h("p", { class: "say-line" }, "本机工具服务监听 ", inline("mcpPort", { cls: "port", numeric: true, placeholder: "" }), "，隧道健康检查用 ", inline("tunnelPort", { cls: "port", numeric: true, placeholder: "" }), "，管理页面在 ", inline("adminPort", { cls: "port", numeric: true, placeholder: "" }), "。")]),
      chapter("tools", "工具集", [h("p", { class: "say-line" }, "向 ChatGPT 提供", tools.box, "。")]),
      chapter("proxy", "出站代理", [h("p", { class: "say-line" }, "Tunnel 出站时", proxy.box, proxyTail, "。")]),
      chapter("desktop", "桌面", core.settings.find(s => s.id === "desktop").fields.map(f => toggleLine(f.key))),
      chapter("reminder", "空档提醒", [
        h("p", { class: "say-line" }, "对话停止调用工具，", remindChips, "。"),
        h("div",{class:"sound-settings"},
          h("p",{class:"say-line"},"提示音使用 ",soundChoice,"。"),
          h("div",{class:"sound-actions"},
            h("button",{type:"button",class:"ghost",onclick:async()=>{
              const result=await A.previewNotificationSound(soundPicker.value);
              if(result?.played===false)toast("音频未播放，请检查音量和 Windows 声音设置。");
            }},icon(I.play),"试听"),
            h("button",{type:"button",class:"ghost",title:"WAV / MP3 · 最多 8MB、2 分钟，使用前 5 秒",onclick:()=>soundFile.click()},icon(I.folder),"导入音频"),
            soundFile,
            h("label",{class:"sound-volume-line"},"音量",volumeSlider,h("span",{id:"sound-volume-value"},"100%"))))]),
      chapter("conversations","会话标签",[
        h("p",{class:"say-line"},h("button",{class:"sentence-action",id:"btn-manage-conversations",type:"button",onclick:async()=>{
          const accountId=core.snapshot().selectedId;
          fill($("#conversation-label-list"),h("p",{class:"conversation-empty"},"读取中…"));
          text($("#conversation-count"),"");$("#btn-clear-conversations").disabled=true;
          openDialog($("#dlg-conversations"));
          try { await refreshConversationControls(); } catch(error) { if(core.snapshot().selectedId===accountId)fill($("#conversation-label-list"),h("p",{class:"conversation-empty"},"暂时无法读取会话"));if(error.code!=="STALE")throw error; }
        }},"管理会话",icon(I.open))) ]),
      // Appearance is a property of this window, not of the account: it applies at once and never enters the save draft.
      chapter("appearance", "外观", [h("p", { class: "say-line" }, "界面使用", themeChips, "。")]),
      chapter("maintenance", "维护", [
        h("p", { class: "say-line" }, "需要时，可以", h("button", { class: "ghost strong", type: "button", id: "btn-reset-profiles" }, "重置 Skill / 插件配置"), "，或", h("button", { class: "ghost warn", type: "button", id: "btn-uninstall" }, "卸载并清理数据"), "。"),
        h("details",{class:"quiet-details",id:"data-details"},
          h("summary",null,"数据位置"),
          h("p",{id:"data-location",class:"data-location"}),
          h("div",{class:"detail-actions"},h("button",{class:"ghost",type:"button",id:"btn-copy-data-location",onclick:()=>{
            const location=core.snapshot().info?.accountDataDir;if(location)return A.copyText(location,"数据位置");
          }},icon(I.copy),"复制路径"),h("button",{class:"ghost",type:"button",onclick:()=>A.openRuntime()},icon(I.folder),"打开运行目录")))]),
      chapter("guide", "接入指引", [h("p", { class: "say-line" }, "每个账户使用独立的 Connector 和 Tunnel ID。", h("button", { class: "ghost strong", type: "button", "data-guide": "1" }, "打开接入指引", icon(I.open)))])
    );
    $("#st-index").append(...CHAPTERS.map(([id, title]) => h("button", { type: "button", dataset: { ch: id }, onclick: () => goChapter(id) }, title)));
    toolBar = mk(tools.ind); proxyBar = mk(proxy.ind); themeBar = mk(themeInd); remindBar = mk(remindInd);
    $("#btn-reset-profiles").addEventListener("click", run(async () => { if (await confirmBox("重置 Skill / 插件配置？", "只重置两个 profile 文件，不删除已安装 Skill 或 Tunnel 配置。", "重置")) await A.resetProfiles(); }));
    $("#btn-uninstall").addEventListener("click", run(async () => { if (await confirmBox("卸载桌面端并清理数据？", "会删除配置、日志和已安装 Skill。portable / zip 的 EXE 需之后手动删除。", "卸载并清理")) { try { await A.uninstallApp(); } catch (err) { toast(err.message, "error"); } } }));
    $("#btn-refresh-conversations").addEventListener("click",run(refreshConversationControls));
    $("#btn-clear-conversations").addEventListener("click",run(async()=>{
      const accountId=core.snapshot().selectedId;
      if(!await confirmBox("清空未保留的会话标签？","会删除这些会话的本地名称与编号，包括近期记录。已保留的标签和 ChatGPT 对话不受影响。","清空"))return;
      if(core.snapshot().selectedId!==accountId)throw Error("账户已切换，请重新打开会话标签。");
      await A.clearInactiveConversations();await refreshConversationControls();
    }));
    // Read every chapter at the same line; observer entries only contain changes.
    form.addEventListener("scroll", syncChapter, { passive: true });
    form.addEventListener("scrollend", () => {
      // A previous jump can deliver scrollend after a new jump has started.
      if (chapterNavigation !== null && Math.abs(form.scrollTop - chapterNavigation) <= 1) chapterNavigation = null;
    });
    form.addEventListener("wheel", event => {
      if (chapterNavigation === null || event.ctrlKey || !event.deltaY) return;
      // Chromium can consume the first wheel delta when cancelling smooth scroll.
      // Apply that event ourselves only while a chapter jump is in flight.
      event.preventDefault();
      chapterNavigation = null;
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? form.clientHeight : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      form.scrollTo({ top: form.scrollTop + event.deltaY * unit, behavior: "instant" });
      syncChapter();
    }, { passive: false });
    const resizeChapters = () => {
      // Give even the final short chapter the same reading-line destination.
      const last = form.lastElementChild;
      if (form.clientHeight && last) {
        const padding = `${Math.max(140, form.clientHeight - last.offsetHeight - 4)}px`;
        if (form.style.paddingBottom !== padding) form.style.paddingBottom = padding;
      }
      syncChapter();
    };
    let chapterResizeFrame;
    const chapterResize = new ResizeObserver(() => {
      cancelAnimationFrame(chapterResizeFrame);
      chapterResizeFrame = requestAnimationFrame(resizeChapters);
    });
    chapterResize.observe(form, { box: "border-box" });
    chapterResize.observe(form.lastElementChild);
    resizeChapters();
  }
  function markChapter(id) { $$("#st-index button").forEach(b => b.setAttribute("aria-current", String(b.dataset.ch === id))); }
  function syncChapter() {
    const form = $("#setup-form"), chapters = $$(".chapter", form);
    if (!form.clientHeight || !chapters.length) return;
    const line = form.getBoundingClientRect().top + 5;
    let current = chapters[0];
    for (const chapter of chapters) if (chapter.getBoundingClientRect().top <= line) current = chapter;
    markChapter(current.dataset.ch);
  }
  function goChapter(id) {
    const target = $("#ch-" + id); if (!target) return;
    const form = $("#setup-form");
    const top = form.scrollTop + target.getBoundingClientRect().top - form.getBoundingClientRect().top - 4;
    const destination = Math.max(0, Math.min(top, form.scrollHeight - form.clientHeight));
    chapterNavigation = !RM.matches && Math.abs(destination - form.scrollTop) > 1 ? destination : null;
    form.scrollTo({ top: destination, behavior: RM.matches ? "instant" : "smooth" });
    syncChapter();
  }
  function setDraft(key, value, fromInput) { ui.draft[key] = value; ui.dirty = true; syncForm(!fromInput); pillState("dirty"); }
  function changedCount() { const base = baseDraft(core.snapshot()); return Object.keys(ui.draft).filter(k => String(ui.draft[k] ?? "") !== String(base[k] ?? "")).length; }
  function pillState(kind, msg) {
    const bar = $("#save-bar"), n = kind === "dirty" ? changedCount() : 0;
    if (kind === "dirty" && n === 0) { ui.dirty = false; bar.classList.remove("show", "err", "ok"); return; }
    bar.classList.toggle("err", kind === "err"); bar.classList.toggle("ok", kind === "ok");
    text($("#form-status"), msg || `${n} 处修改还没有保存`);
    $("#btn-discard").hidden = kind === "ok"; $("#btn-save-only").hidden = kind === "ok";
    bar.classList.add("show"); clearTimeout(ui.pillTimer);
    if (kind === "ok") ui.pillTimer = setTimeout(() => bar.classList.remove("show", "ok"), 2600);
  }
  function syncForm(writeInputs) {
    const d = ui.draft, form = $("#setup-form");
    for (const sec of core.settings) for (const f of sec.fields) {
      const box = $(`[data-key="${f.key}"]`, form); if (!box) continue;
      const visible = !f.when || f.when(d);
      if (f.type === "switch") { box.classList.toggle("disabled", !visible); const b = box.querySelector(".switch"); b.disabled = !visible; sw(b, !!d[f.key] && visible); box.dataset.on = String(!!d[f.key] && visible); }
      if (f.type === "choice") $$("[data-value]", box).forEach(c => c.setAttribute("aria-checked", String(c.dataset.value === d[f.key])));
      if (writeInputs && ["text", "password", "path", "port"].includes(f.type)) { const input = $("#f-" + f.key); if (input && document.activeElement !== input) { input.value = f.key === "apiKey" ? (d.apiKey || "") : (d[f.key] ?? ""); fit(input); } }
      box.classList.remove("invalid");
    }
    $("#proxy-tail").hidden = d.tunnelProxyMode !== "custom";
    const snapshot = core.snapshot();
    const existing = snapshot.accounts.find(row => row.id !== snapshot.selectedId && row.config?.tunnelId && row.config.tunnelId === String(d.tunnelId || "").trim());
    $("#setup-reuse").hidden = !existing;
    if (existing) {
      text($("#setup-reuse-text"), `已有账户「${existing.name}」 · MCP ${existing.config.mcpPort}`);
      $("#btn-setup-reuse").onclick = run(() => A.selectAccount(existing.id));
    }
    requestAnimationFrame(placeIndicators);
  }
  function baseDraft(s) {
    const c = s.account.config || {}, info = s.info || {}, b = {};
    for (const sec of core.settings) for (const f of sec.fields) b[f.key] = f.key === "apiKey" ? "" : c[f.key] ?? (f.type === "switch" ? false : "");
    if (!b.tunnelId && info.legacyTunnelId) b.tunnelId = info.legacyTunnelId;
    if (!b.workspacePath && info.legacyWorkspace) b.workspacePath = info.legacyWorkspace;
    b.tunnelProxyMode = b.tunnelProxyMode || "auto"; b.toolProfile = b.toolProfile || "slim";
    return b;
  }
  function fillForm(s) {
    const c = s.account.config || {};
    ui.draft = baseDraft(s); ui.dirty = false; syncForm(true); syncRemindControls(reminderOf(s));
    refreshSoundControls().catch(()=>{});
    $("#f-apiKey").placeholder = "sk-…"; fit($("#f-apiKey"));
    text($("#key-lead"), c.hasApiKey ? "Runtime API Key 已加密保存，要更换就填在这里 " : "Runtime API Key 是 ");
    text($("#setup-account"), s.account.name);
    text($("#btn-run-setup"), c.setupDone ? "重新检查配置" : "开始初始化");
    $("#save-bar").classList.remove("show", "err", "ok");
  }
  function payload() { return { ...ui.draft }; }
  function invalidate(msg) {
    pillState("err", msg);
    const keys = /端口/.test(msg) ? ["mcpPort", "tunnelPort", "adminPort"] : /Tunnel ID/.test(msg) ? ["tunnelId"] : /代理/.test(msg) ? ["tunnelProxyUrl"] : /API Key/.test(msg) ? ["apiKey"] : /工作区/.test(msg) ? ["workspacePath"] : [];
    keys.forEach(k => $(`[data-key="${k}"]`, $("#setup-form"))?.classList.add("invalid"));
    if (keys[0]) { const ch = $(`[data-key="${keys[0]}"]`, $("#setup-form"))?.closest(".chapter"); if (ch) goChapter(ch.dataset.ch); }
  }
  $("#btn-save-only").addEventListener("click", async () => {
    const err = core.validate(payload()); if (err) return invalidate(err);
    const button = $("#btn-save-only"), savedDraft = JSON.stringify(ui.draft), accountId = core.snapshot().selectedId;
    setBtn(button, false, true);
    try {
      await A.saveConfig(payload());
      if (core.snapshot().selectedId !== accountId) return;
      if (JSON.stringify(ui.draft) === savedDraft) { fillForm(core.snapshot()); pillState("ok", "已保存。端口与工具集在重启服务后生效。"); }
      else { syncForm(false); pillState("dirty"); }
    } catch (e) { if (core.snapshot().selectedId === accountId) invalidate(e.message); }
    finally { setBtn(button, false, false); }
  });
  $("#btn-discard").addEventListener("click", () => fillForm(core.snapshot()));
  $("#btn-run-setup").addEventListener("click", async () => {
    const err = core.validate(payload()); if (err) return invalidate(err);
    const log = $("#setup-log");
    log.textContent = "开始初始化\n"; text($("#setup-title"), "正在初始化"); text($("#setup-desc"), "准备本机 MCP，等待就绪后检查连接配置。");
    $("#setup-failure").hidden = true; $("#setup-checks").replaceChildren();
    $("#setup-details").open = true; $("#setup-retry").hidden = true;
    $("#setup-switch-account").hidden = true;
    $("#setup-done").disabled = true; text($("#setup-done"), "完成"); $("#setup-guide").hidden = true;
    openDialog($("#dlg-setup")); busy.set(1); kick();
    setBtn($("#btn-run-setup"), false, true);
    try { await A.runSetup(payload()); fillForm(core.snapshot()); log.textContent += "初始化完成。\n"; text($("#setup-title"), "初始化完成"); text($("#setup-desc"), "接下来在 ChatGPT 网页端添加这个应用。"); $("#setup-guide").hidden = false; }
    catch (e) {
      log.textContent += "失败：" + e.message + "\n";
      if (e.code) log.textContent += "错误代码：" + e.code + "\n";
      if (e.details && !log.textContent.includes(e.details)) log.textContent += e.details + "\n";
      text($("#setup-title"), e.title || "初始化没有完成"); text($("#setup-desc"), e.message);
      const stages = { config: "保存账户配置", workspace: "准备工作区", download: "准备连接组件", "local-mcp": "启动本机 MCP", doctor: "检查本机服务与连接配置" };
      const labels = { mcp_server_reachable: "本机 MCP 连接", oauth_metadata: "本机认证元数据", config_source: "配置文件", profile_load: "读取账户配置", tunnel_id: "Tunnel ID", control_plane_api_key: "Runtime API Key", mcp_target: "本机 MCP 地址" };
      text($("#setup-stage"), `失败步骤：${stages[e.stage] || "准备或检查初始化配置"}`);
      $("#setup-checks").replaceChildren(...(e.checks || []).filter(c => c.status === "FAIL").map(c => h("li", null, `${labels[c.name] || c.name}：${c.message || "未通过"}`)));
      text($("#setup-next"), "下一步：" + (e.nextAction || "按上面的原因修正配置后重试；可展开或复制诊断详情。"));
      $("#setup-failure").hidden = false; $("#setup-details").open = false;
      $("#setup-retry").hidden = !!e.existingAccountId;
      $("#setup-switch-account").hidden = !e.existingAccountId;
      if (e.existingAccountId) $("#setup-switch-account").onclick = run(async () => { $("#dlg-setup").close(); await A.selectAccount(e.existingAccountId); });
      text($("#setup-done"), "关闭"); invalidate(e.message);
    }
    finally { setBtn($("#btn-run-setup"), false, false); $("#setup-done").disabled = false; renderWorkspace(core.snapshot()); }
  });
  $("#dlg-setup").addEventListener("cancel", e => { if ($("#setup-done").disabled) e.preventDefault(); });
  $("#setup-retry").addEventListener("click", () => { $("#dlg-setup").close(); $("#btn-run-setup").click(); });
  $("#setup-copy").addEventListener("click", run(() => A.copyText([$("#setup-title").textContent, $("#setup-desc").textContent, !$("#setup-failure").hidden ? $("#setup-failure").textContent : "", $("#setup-log").textContent].filter(Boolean).join("\n\n"), "初始化诊断")));
  $("#setup-guide").addEventListener("click", () => { $("#dlg-setup").close(); openGuide(1); });
  core.on("setup-progress", line => { const log = $("#setup-log"); if (line) { log.textContent += line + "\n"; log.scrollTop = log.scrollHeight; } });

  /* ===================== 接入指引 ===================== */
  const GUIDE_TITLES = ["确认服务就绪", "打开 Connectors", "新建连接器", "创建并连接", "放开操作权限", "发送只读探针", "其他账户"];
  const PROBE = "请只读取工作区目录列表，不要修改任何文件。";
  function openGuide(step) { ui.guideStep = step != null ? step : core.snapshot().derived.cloudOnline ? 1 : 0; renderGuide(); openDialog($("#dlg-guide")); }
  function renderGuide() {
    const s = core.snapshot(), a = s.account, id = (a.config && a.config.tunnelId) || "", i = ui.guideStep;
    text($("#guide-sub"), `账户 · ${a.name}`);
    $("#guide-steps").replaceChildren(...GUIDE_TITLES.map((t, k) => h("li", null, h("button", { type: "button", class: k < i ? "done" : "", "aria-current": k === i ? "step" : null, onclick: () => { ui.guideStep = k; renderGuide(); } }, h("span", { class: "bead" }, k < i ? "✓" : k + 1), h("b", null, t)))));
    const acts = [];
    if (i === 0) acts.push(h("span", { class: "badge", dataset: { tone: s.derived.cloudOnline ? "ok" : s.derived.tone } }, s.derived.title), s.derived.cloudOnline ? null : h("button", { class: "ghost strong", type: "button", onclick: () => { $("#dlg-guide").close(); setView("workspace"); } }, "回到工作空间启动"));
    if (i === 1) acts.push(h("button", { class: "btn small", type: "button", onclick: () => A.openExternal("https://chatgpt.com/#settings/Connectors") }, "打开 Connectors", icon(I.open)));
    if (i === 5) acts.push(h("button", { class: "ghost strong", type: "button", onclick: () => A.copyText(PROBE, "探针提示词") }, icon(I.copy), "复制探针提示词"));
    if (i === 6) acts.push(h("button", { class: "ghost strong", type: "button", onclick: async () => { $("#dlg-guide").close(); const name = await nameBox("create"); if (name) try { await A.createAccount(name); } catch (err) { toast(err.message, "error"); } } }, icon(I.add), "新建账户"));
    fill($("#guide-detail"), h("span", { class: "num" }, String(i + 1).padStart(2, "0")), h("h3", null, GUIDE_TITLES[i]), h("p", null, core.guide[i](a)),
      i === 2 ? h("div", { class: "copy" }, h("code", null, id || "（尚未配置 Tunnel ID）"), h("button", { class: "ghost strong", type: "button", onclick: () => id ? A.copyText(id, " Tunnel ID") : toast("尚未配置 Tunnel ID。", "error") }, icon(I.copy), "复制")) : null,
      i === 5 ? h("div", { class: "copy" }, h("code", null, PROBE)) : null,
      h("div", { class: "acts" }, ...acts));
    $("#guide-prev").disabled = i === 0; text($("#guide-next"), i === GUIDE_TITLES.length - 1 ? "完成" : "下一步");
  }
  $("#guide-prev").addEventListener("click", () => { ui.guideStep = Math.max(0, ui.guideStep - 1); renderGuide(); });
  $("#guide-next").addEventListener("click", () => { if (ui.guideStep >= GUIDE_TITLES.length - 1) return $("#dlg-guide").close(); ui.guideStep++; renderGuide(); });
  $("#btn-open-guide").addEventListener("click", () => openGuide());

  /* ===================== keyboard, prototype menu ===================== */
  document.addEventListener("keydown", e => {
    if (e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); setView(VIEWS[e.key - 1]); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); if (ui.view === "skills") return $("#skill-search").focus(); if (ui.view !== "logs") setView("logs"); setTimeout(() => { $("#log-search").focus(); $("#log-search").select(); }, 30); return; }
    if (e.key === "Escape" && !$("dialog[open]")) { if (ui.pop) { closePop(); return; } if (ui.skillPop) { closeSkillPop(); return; } if (!$("#install-sheet").hidden) { hideInstall(true); return; } closeMenu(); }
    if (e.key === "?" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !$("dialog[open]")) { e.preventDefault(); openDialog($("#dlg-keys")); }
  });
  if (core.mode === "preview") {
    const list = h("div", { class: "proto-menu-list", role: "menu" });
    const menu = h("details", { class: "proto-menu" }, h("summary", { title: "预览工具：切换模拟场景，不影响真实服务" }, "预览", h("span", { class: "proto-menu-label" }, "切换场景")), list);
    for (const [name, title] of core.scenarios) list.append(h("button", { type: "button", role: "menuitemradio", dataset: { scenario: name }, onclick: () => { A.setScenario(name); menu.open = false; } }, title));
    list.append(h("button", { type: "button", onclick: () => { A.simulateCall(); menu.open = false; } }, "模拟一次调用"));
    $("#proto").append(menu);
    document.addEventListener("click", e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
    core.on("change", () => { const s = core.snapshot(); $$("[data-scenario]", list).forEach(b => b.setAttribute("aria-checked", String(b.dataset.scenario === s.scenario))); });
  }
  if (params.has("still")) $("#proto").hidden = true;

  /* ===================== wiring ===================== */
  function render() {
    const s = core.snapshot();
    renderAccounts(s); renderWorkspace(s); renderSkills(s);
    text($("#data-location"), s.info?.accountDataDir || "仅桌面版显示实际路径");
    if ($("#btn-copy-data-location")) $("#btn-copy-data-location").disabled = !s.info?.accountDataDir;
    if (ui.view === "logs") { logMeta(s); renderSpectrum(s); }
    if ($("#dlg-guide").open) renderGuide();
  }
  core.on("change", render);
  core.on("account", () => {
    hideInstall(true); closeSkillPop(); closePop(); closeMenu(); activeChoice?.close();
    if ($("#dlg-account-import").open) $("#dlg-account-import").close();
    if ($("#dlg-conversations").open) $("#dlg-conversations").close();
    $("#conversation-label-list").replaceChildren();
    $("#ext-path").value = ""; $("#ext-name").value = "";
    ui.lastSig = {}; ui.liveKey = ""; fillForm(core.snapshot()); renderLogs(); render();
  });
  setInterval(() => { if (!document.hidden) { const s = core.snapshot(); renderWorkspace(s); if (ui.view === "logs") renderSpectrum(s); } }, 1000);

  buildSettings();
  syncThemeControls();
  const first = core.snapshot();
  fillForm(first);
  const startView = VIEWS.includes(params.get("sheet")) ? params.get("sheet") : "workspace";
  ui.view = startView; document.body.dataset.view = startView;
  for (const v of VIEWS) $("#view-" + v).hidden = v !== startView;
  $$("#nav [role=tab]").forEach(t => t.setAttribute("aria-selected", String(t.dataset.view === startView)));
  render();
  for (const s of [on, warm, alarm, busy]) s.jump(s.target);
  if (first.activity.some(r => r.phase === "running")) active.jump(1);
  placePresence(true);
  if (startView === "logs") { renderLogs(); renderSpectrum(first); }
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    // Occluded windows can stop receiving animation frames. The timeout must
    // reveal usable controls independently of the scene's next painted frame.
    placePresence(true); placeIndicators(); document.body.classList.remove("booting"); kick();
  };
  if (scene) { scene.whenReady(() => { kick(); requestAnimationFrame(reveal); }); setTimeout(reveal, 4000); } else reveal();
  window.__harness = { core, setView, openGuide, applyTheme, refreshSkills, setReminder };
})();
