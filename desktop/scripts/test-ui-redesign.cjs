"use strict";
// Actual Electron/Chromium integration tests. Fixtures are isolated and visibly labelled.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { _electron } = require("playwright-core");
const root = path.resolve(__dirname, "../..");
const args = process.argv.slice(2);
const option = name => args.find(a => a.startsWith(name + "="))?.slice(name.length + 1);
const out = path.resolve(option("--out") || path.join(root, ".codex/ui-redesign"));
const scale = Number(option("--scale") || 1);
const smoke = args.includes("--smoke");
fs.mkdirSync(out, { recursive: true });
const checks = [], screenshots = [], errors = [];
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let app, page;
const pass = name => { checks.push(name); console.log("PASS " + name); };
async function frame() { await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }); }
async function size(width,height) {
  await app.evaluate(({BrowserWindow},dims)=>BrowserWindow.getAllWindows()[0].setContentSize(...dims),[width,height]);
  if (scale === 1) {
    // The three required baseline sizes remain exact, without tolerance.
    await page.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{width,height},{timeout:3000});
  } else {
    // Native Windows non-client rounding can add one CSS pixel at high DPI.
    // Do not repeatedly resize to chase a rounding oscillation. Record the actual
    // viewport and PNG dimensions below instead of claiming the requested size.
    await page.waitForFunction(({width,height})=>Math.abs(innerWidth-width)<=1&&Math.abs(innerHeight-height)<=1,{width,height},{timeout:3000});
  }
  await frame();
}
async function navigate(view) { await page.locator(`.nav-item[data-view="${view}"]`).click(); await page.waitForFunction(v=>state.view===v,view);if(view==="skills")await page.waitForFunction(()=>Boolean(state.skills));await frame(); }
async function capture(name,width=1440,height=900,anchor=null) {
  await size(width,height);
  await page.evaluate(()=>{document.getElementById("main-content").scrollTop=0;document.querySelectorAll(".toast-close").forEach(b=>b.click());});
  if (anchor) { await page.locator(anchor).scrollIntoViewIfNeeded(); await frame(); }
  await frame();
  const layout=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,documentOverflow:document.documentElement.scrollWidth>innerWidth,mainOverflow:document.getElementById("main-content").scrollWidth>document.getElementById("main-content").clientWidth+1}));
  assert.equal(layout.documentOverflow,false,name+" document overflow");assert.equal(layout.mainOverflow,false,name+" main overflow");
  const file=path.join(out,`${name}-${layout.width}x${layout.height}${scale!==1?'-dpi'+scale:''}.png`);
  const png = await app.evaluate(async ({BrowserWindow}) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
  fs.writeFileSync(file,Buffer.from(png,"base64"));
  const bytes=fs.readFileSync(file);
  screenshots.push({file:path.basename(file),sha256:hash(file),bytes:bytes.length,requestedWidth:width,requestedHeight:height,pixelWidth:bytes.readUInt32BE(16),pixelHeight:bytes.readUInt32BE(20),...layout});
  console.log("CAPTURE " + path.basename(file));
}
async function scenario(name) { await app.evaluate((_,n)=>global.__uiPreview.scenario(n),name);await frame(); }
async function read(id) { return page.locator('#'+id).innerText(); }
(async()=>{
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:require("electron"),args:[path.join(__dirname,"ui-preview.cjs"),"--test","--hold-init",`--scale=${scale}`],cwd:root,env,timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(8000);page.setDefaultNavigationTimeout(15000);page.on("pageerror",error=>errors.push(error.message));
  await page.waitForFunction(()=>document.body.classList.contains("is-loading") && document.getElementById("main-content").inert);
  await capture("initial-loading",1280,720);
  await app.evaluate(()=>global.__uiPreview.releaseInitialization());
  pass("initial-loading-locks-actions-until-context-ready");
  await page.waitForFunction(()=>typeof state!=="undefined"&&Boolean(state.status),null,{timeout:20000});
  assert.equal(await page.locator("#runtime-notice").isVisible(),false,"No initialization error");
  assert.equal(await page.locator("#preview-label").isVisible(),true,"Fixture must be explicitly labelled");
  assert.equal(await page.evaluate(()=>typeof require),"undefined","Node integration disabled");
  pass("real-renderer-and-production-preload-in-isolated-Electron");
  const sizes=smoke?[[1440,900]]:[[1280,720],[1440,900],[1920,1080]];
  for(const [width,height] of sizes) {
    await navigate("dashboard");await capture("dashboard",width,height);
    await navigate("skills");await capture("skills",width,height);
    await navigate("logs");await capture("logs",width,height);
    await navigate("settings");await capture("settings",width,height);
  }
  assert.equal(await page.locator(".brand-logo").getAttribute("src"),"logo.png");
  assert.equal(await page.locator(".page-intro, .eyebrow, .section-kicker").count(),0);
  assert.doesNotMatch(await page.locator("body").innerText(),/一切运行|扩展你的工作流|让每一次执行|为每个账户，配置独立环境|更快地工作/);
  pass("main-page-responsive-rendering");
  if(!smoke) {
    await size(1440,900);
    await navigate("dashboard");
    assert.equal(await read("mcp-tool-count"),"77");assert.equal(await read("mcp-listen-port"),"3400");assert.match(await read("badge-tunnel"),/云端待确认/);
    const cases=[["online",/服务已就绪/,/云端已连接/],["stopped",/服务未启动/,/未运行/],["starting",/服务启动中/,/连接中/],["stopping",/正在停止/,/停止中/],["auth-error",/云端认证失败/,/401/],["network-error",/待恢复/,/连接异常/],["stale",/待恢复/,/过期/],["crashed",/异常退出/,/异常退出/],["port-conflict",/被占用/,null],["unconfigured",/账户未配置/,null]];
    for(const [name,title,badge] of cases){await scenario(name);assert.match(await read("overview-title"),title);if(badge)assert.match(await read("badge-tunnel"),badge);await capture("state-"+name,1280,720);}
    pass("ten-runtime-states-with-local-cloud-distinction");
    await scenario("long-path");await app.evaluate(()=>global.__uiPreview.longAccount());await capture("long-path",1280,720);
    pass("long-path-and-mixed-language-account");
    await scenario("waiting");
    await navigate("logs");
    await app.evaluate(()=>global.__uiPreview.append("mcp",["11:00:01 [error] injected error <script>window.PWNED=1</script>","11:00:02 [warn] injected warning","11:00:03 [HTTP] GET /health 200 1ms"]));
    assert.equal(await page.evaluate(()=>window.PWNED),undefined);
    await page.locator("#log-search").fill("injected error");await frame();assert.equal(await page.locator("#log-view > span").count(),1);
    await page.locator("#btn-copy-log").click();assert.match(await app.evaluate(()=>global.__previewClipboard),/injected error <script>/);
    await page.locator("#log-search").fill("");await page.locator("#log-level").selectOption("warn");await frame();assert.equal(await page.locator("#log-view .error").count(),0);assert.ok(await page.locator("#log-view .warn").count()>0);
    await page.locator("#log-level").selectOption("all");await page.locator("#log-hide-health").check();await frame();assert.doesNotMatch(await read("log-view"),/GET \/health/);
    await page.locator("#log-search").fill("no-such-log-value");await frame();assert.equal(await page.locator("#log-empty").isVisible(),true);await capture("logs-no-matches");
    await page.locator("#log-search").fill("");await page.locator("#log-hide-health").uncheck();await frame();
    await page.locator("#log-autoscroll").uncheck();await app.evaluate(()=>global.__uiPreview.append("mcp",Array.from({length:100},(_,i)=>`11:10:00 [info] scroll event ${i}`)));await page.evaluate(()=>document.getElementById("log-view").scrollTop=100);const scroll=await page.locator("#log-view").evaluate(e=>e.scrollTop);await app.evaluate(()=>global.__uiPreview.append("mcp",["11:11:00 [info] keep position"]));assert.equal(await page.locator("#log-view").evaluate(e=>e.scrollTop),scroll);
    pass("log-search-level-health-filter-copy-literal-input-scroll");
    await page.locator('[data-log="tunnel"]').click();await page.locator("#btn-clear-log").click();await frame();assert.equal(await page.locator("#log-empty").isVisible(),true);assert.ok(await page.evaluate(()=>state.logs.mcp.length)>0);await capture("logs-empty");
    await page.keyboard.press("Control+f");assert.equal(await page.evaluate(()=>document.activeElement.id),"log-search");
    await page.locator('[data-log="mcp"]').focus();await page.keyboard.press("ArrowRight");assert.equal(await page.evaluate(()=>state.activeLog),"tunnel");
    pass("log-tabs-clear-scope-keyboard");
    await navigate("dashboard");await page.locator("#btn-expand-log").click();assert.equal(await page.evaluate(()=>state.view),"logs");assert.equal(await page.locator("#log-panel").count(),1);await page.locator("#btn-expand-log").click();assert.equal(await page.evaluate(()=>state.view),"dashboard");
    await page.locator("#btn-account-create").click();await page.locator("#account-dialog").waitFor({state:"visible"});await capture("account-dialog");await page.keyboard.press("Escape");assert.equal(await page.locator("#account-dialog").isVisible(),false);
    await page.locator("#btn-account-rename").click();await page.locator("#account-dialog-name").fill("Personal workspace");await page.locator("#account-dialog-submit").click();await page.waitForFunction(()=>!state.accountSwitching);assert.equal(await read("dashboard-account-name"),"Personal workspace");
    await page.locator("#account-select").selectOption("preview-lab");await page.waitForFunction(()=>state.accountId==="preview-lab"&&!state.accountSwitching);assert.equal(await read("mcp-listen-port"),"3410");
    const before=await page.evaluate(()=>state.logs.mcp.length);await app.evaluate(()=>global.__uiPreview.append("mcp",["11:20:00 [info] foreign-account-only"],"preview-main"));assert.equal(await page.evaluate(()=>state.logs.mcp.length),before);
    await page.locator("#account-select").selectOption("preview-main");await page.waitForFunction(()=>state.accountId==="preview-main"&&!state.accountSwitching);assert.equal(await read("mcp-listen-port"),"3400");
    pass("account-dialog-rename-switch-and-event-isolation");
    await navigate("skills");await page.locator("#skill-search").fill("release");assert.equal(await page.locator("#installed-skills-list .skill-row:visible").count(),1);await page.locator("#skill-search").fill("");
    const toggle=page.locator("#installed-skills-list .switch input").first();await toggle.uncheck();await page.waitForFunction(()=>state.skills.installed[0].enabled===false);await toggle.check();await page.waitForFunction(()=>state.skills.installed[0].enabled===true);
    await page.locator("#chk-browser-use").uncheck();await page.waitForFunction(()=>state.skills.browserUse.enabled===false);await page.locator("#chk-browser-use").check();await page.waitForFunction(()=>state.skills.browserUse.enabled===true);
    await page.locator("#btn-install-skill-folder").click();await page.locator("#install-skill-panel").waitFor({state:"visible"});await capture("skill-install");await page.locator("#btn-install-cancel").click();
    await page.locator("#btn-install-skill-folder").click(); await page.locator("#install-skill-panel").waitFor({state:"visible"}); await page.locator("#btn-install-confirm").click();
    await page.waitForFunction(()=>state.skills.installed.some(s=>s.id==="new-workflow"));
    await page.locator("#installed-skills-list .skill-row").filter({hasText:"new-workflow"}).getByRole("button",{name:"卸载",exact:true}).click();
    await page.locator("#confirm-submit").click(); await page.waitForFunction(()=>!state.skills.installed.some(s=>s.id==="new-workflow"));
    await capture("skills-discovery",1440,900,"#builtin-skills-list");
    pass("skill-filter-and-provider-controls-install-dialog");
    pass("skill-install-and-uninstall-through-real-preload");
    await navigate("settings");await page.locator('[data-settings-tab="guide"]').click();await capture("connection-guide");await page.locator('[data-settings-tab="setup"]').click();
    await page.locator("#f-tunnel-proxy-mode").selectOption("custom");assert.equal(await page.locator("#f-tunnel-proxy-url").isEnabled(),true);await page.locator("#f-tunnel-proxy-url").fill("http://127.0.0.1:7890");await page.locator("#btn-save-only").click();await page.waitForFunction(()=>state.config.tunnelProxyMode==="custom");
    await page.locator("details.relay-section summary").click();await page.locator("#f-relay-enabled").check();await page.locator("#f-relay-auto").check();assert.equal(await page.locator("#f-relay-recovery").isEnabled(),true);await page.locator("#f-relay-enabled").uncheck();assert.equal(await page.locator("#f-relay-auto").isChecked(),false);assert.equal(await page.locator("#f-relay-recovery").isEnabled(),false);
    await page.locator("#btn-reset-profiles").click();await page.locator("#confirm-dialog").waitFor({state:"visible"});assert.equal(await page.evaluate(()=>document.activeElement.id),"confirm-cancel");await capture("confirmation-dialog");await page.keyboard.press("Escape");assert.equal(await page.locator("#confirm-dialog").isVisible(),false);
    await page.locator("#btn-diagnostics").click();await capture("runtime-diagnostics");await page.keyboard.press("Escape");
    await page.locator("#btn-shortcuts").click();await capture("keyboard-shortcuts");await page.keyboard.press("Escape");
    await capture("settings-preferences",1440,900,"#btn-save-only");
    pass("settings-save-proxy-relay-dialogs-and-diagnostics");
    await navigate("dashboard");await scenario("stopped");
    await app.evaluate(()=>global.__uiPreview.fail("mcp:start"));await page.locator("#btn-mcp-start").click();await page.waitForFunction(()=>pendingActions.size===0);assert.equal(await page.locator("#mcp-action-error").isVisible(),true);await capture("action-error");
    const oldCalls=(await app.evaluate(()=>global.__uiPreview.calls())).filter(c=>c.channel==="mcp:start").length;
    await page.locator("#btn-mcp-start").click();await page.waitForFunction(()=>pendingActions.size>0);assert.equal(await page.locator("#btn-mcp-start").isDisabled(),true);await page.waitForFunction(()=>pendingActions.size===0);assert.equal((await app.evaluate(()=>global.__uiPreview.calls())).filter(c=>c.channel==="mcp:start").length,oldCalls+1);
    pass("action-pending-error-feedback-and-no-double-dispatch");
    await page.emulateMedia({reducedMotion:"reduce"});await scenario("starting");assert.equal(await page.locator("#badge-mcp .dot").evaluate(e=>getComputedStyle(e).animationName),"none");await capture("reduced-motion");
    await scenario("waiting");await page.emulateMedia({reducedMotion:"no-preference"});await capture("minimum-window",900,600);
    pass("reduced-motion-and-minimum-window");
    await navigate("logs"); await page.locator('[data-log="mcp"]').click(); await page.locator("#log-level").selectOption("error"); await frame();
    await app.evaluate(() => global.__uiPreview.append("mcp", Array.from({length:3100}, (_, i) => `12:00:00 [info] retention event ${i}`))); await frame();
    assert.equal(await page.evaluate(() => state.logs.mcp.length), 3000); assert.equal(await page.locator("#log-view > span").count(), 0);
    await navigate("skills"); await app.evaluate(() => global.__uiPreview.append("mcp", ["12:01:00 [error] retained while hidden"])); await navigate("logs");
    assert.equal(await page.locator("#log-view > span").count(), 1);
    pass("filtered-buffer-cap-and-hidden-page-reconciliation");
  }
  assert.deepEqual(errors,[],"No renderer exceptions");
  const sources=["desktop/renderer/index.html","desktop/renderer/app.js","desktop/renderer/ui.js","desktop/renderer/styles.css","desktop/src/preload.js","desktop/scripts/ui-preview.cjs","desktop/scripts/test-ui-redesign.cjs"].map(file=>({file,sha256:hash(path.join(root,file))}));
  fs.writeFileSync(path.join(out,"result.json"),JSON.stringify({status:"PASS",at:new Date().toISOString(),checks,screenshots,sources,scale,mode:smoke?"smoke":"full",visualInspection:"Requires separate human/model pixel review; screenshots alone do not establish design acceptance.",safety:{realRenderer:true,realPreload:true,productionMainLoaded:false,networkDisabled:true,realServicesControlled:false,realCredentialsRead:false},errors},null,2));
  console.log("PASS_ALL " + JSON.stringify({checks:checks.length,screenshots:screenshots.length,out}));
})().catch(async error=>{
  console.error(error.stack||error);
  if(page) { try { const png=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));fs.writeFileSync(path.join(out,"failure.png"),Buffer.from(png,"base64"));console.error("DOM_STATE "+JSON.stringify(await page.evaluate(()=>({view:typeof state!=="undefined"?state.view:null,notice:document.getElementById("runtime-notice")?.textContent,toasts:document.getElementById("toasts")?.textContent})))); }catch{} }
  fs.writeFileSync(path.join(out,"failure.json"),JSON.stringify({error:String(error.stack||error),errors,checks,screenshots},null,2));
  process.exitCode=1;
}).finally(async()=>{if(app)await app.close();});
