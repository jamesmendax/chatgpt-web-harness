"use strict";
// Real Aura + production sandboxed preload, with ui-preview's in-memory IPC only.
// Never import production main.js, start services, or read real account data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { app, BrowserWindow } = require("electron");
const desktop = path.resolve(__dirname, "..");
const artifacts = path.resolve(desktop, "../.validation/aura-preferences");
fs.mkdirSync(artifacts, { recursive: true });
const output = fs.mkdtempSync(path.join(artifacts, "run-"));
const sourceFiles = ["renderer/v3/aura/index.html", "renderer/v3/aura/app.js", "renderer/v3/aura/aura.css", "renderer/v3/core/core.js", "src/preload.js", "scripts/ui-preview.cjs", "scripts/test-aura-preferences.cjs"];
const sourceHashes = () => sourceFiles.map(file => ({ file: "desktop/" + file, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(desktop, file))).digest("hex") }));
const sourceBaseline = sourceHashes();
for (const flag of ["--test", "--aura"]) if (!process.argv.includes(flag)) process.argv.push(flag);
require("./ui-preview.cjs");

let win, preview, finished = false;
const checks = [], screenshots = [], logOutcomes = [], historyOutcomes = [], pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code);
const click = selector => js("document.querySelector(" + JSON.stringify(selector) + ").click()");
async function until(read, label, budget = 12000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) { if (await read()) return; await pause(40); }
  throw new Error("Timed out: " + label);
}
const wait = (code, label) => until(() => js(code), label);
function pass(label) { checks.push(label); console.log("PASS " + label); }
const conversationWrites = () => preview.calls().filter(call => /^conversations:(rename|pin|clearInactive)$/.test(call.channel));
async function switchAccount(id) {
  await js("window.__harness.core.act.selectAccount(" + JSON.stringify(id) + ")");
  await wait("window.__harness.core.snapshot().selectedId===" + JSON.stringify(id), "account switch");
}
async function openConversations() {
  await click("#btn-manage-conversations");
  await wait("document.querySelector('#dlg-conversations').open && document.querySelectorAll('#conversation-label-list .conversation-item').length>0", "conversation list");
}
async function chooseSound(value) {
  await js("(()=>{const select=document.querySelector('#sound-choice'),index=[...select.options].findIndex(option=>option.value===" + JSON.stringify(value) + ");if(index<0)throw Error('Missing fixture sound');document.querySelector('#sound-choice-trigger').click();const option=document.querySelector('#sound-choice-option-'+index);if(!option||option.disabled)throw Error('Unavailable fixture sound');option.click();})()");
}
function finish(error) {
  if (finished) return;
  finished = true; clearTimeout(deadline);
  const sources = sourceHashes();
  const sourcesUnchanged = JSON.stringify(sources) === JSON.stringify(sourceBaseline);
  if (!sourcesUnchanged && !error) error = new Error("Aura sources changed during this test; results do not describe one frozen source snapshot.");
  const result = { ok: !error, checks, sources, sourcesUnchanged, screenshots, logOutcomes, historyOutcomes, output, fixtureDir: preview?.fixtureDir,
    renderer: "desktop/renderer/v3/aura/index.html", servicesStarted: false, realConfigurationRead: false,
    calls: preview?.calls().map(({ channel, accountId }) => ({ channel, accountId })),
    limitations: ["The existing fixture has no delayed conversations:list hook; late failed-read interleaving is not simulated."],
    ...(error ? { error: error.stack || String(error) } : {}) };
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
  if (error) console.error(error.stack || error);
  console.log("RESULT " + output);
  app.exit(error ? 1 : 0);
}
const deadline = setTimeout(() => finish(new Error("Preference regression deadline")), 60000);
(async () => {
  await app.whenReady();
  await until(() => Boolean(BrowserWindow.getAllWindows()[0]), "isolated preview window");
  win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoadingMainFrame()) await new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  await wait("Boolean(window.__harness && !document.body.classList.contains('booting'))", "Aura ready");
  preview = global.__uiPreview;
  assert.equal(app.getPath("userData"), preview.fixtureDir);
  assert.equal(win.webContents.getLastWebPreferences().contextIsolation, true);
  assert.equal(win.webContents.getLastWebPreferences().sandbox, true);
  assert.equal(require.cache[path.join(desktop, "src/main.js")], undefined, "production main must never load");
  assert.equal(await js("window.__harness.core.mode"), "electron", "use the production preload adapter");
  await js("window.__preferencesErrors=[];addEventListener('unhandledrejection',event=>window.__preferencesErrors.push(String(event.reason)));window.__harness.setView('settings')");
  const a = "preview-main", b = "preview-lab";

  await click('#remind-chips [data-value="10"]');
  await until(() => preview.snapshot(a).config.idleReminderMinutes === 10, "saved reminder");
  await chooseSound("bells");
  await until(() => preview.fixturePreferences(a).sounds.selected === "bells", "saved sound");
  await wait("!document.querySelector('#sound-choice-trigger').disabled", "sound selection complete");
  await js("(()=>{const volume=document.querySelector('#sound-volume');volume.value='60';volume.dispatchEvent(new Event('input',{bubbles:true}));volume.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await until(() => preview.fixturePreferences(a).sounds.volume === 60, "saved volume");
  await wait("document.querySelector('#sound-volume-value').textContent==='60%'", "volume feedback");
  assert.equal(preview.snapshot(a).config.idleReminderMinutes, 10);
  assert.deepEqual(preview.fixturePreferences(a).sounds, { selected: "bells", volume: 60, hasCustom: true });
  assert.deepEqual(preview.fixturePreferences(b).sounds, { selected: "glass", volume: 100, hasCustom: false });
  pass("reminder, selected sound and volume save through real Aura listeners into the active fixture account");

  await openConversations();
  await js("(()=>{const row=document.querySelectorAll('#conversation-label-list .conversation-item')[1];row.querySelector('input').value='账户 A 的备注';row.querySelectorAll('button')[0].click();})()");
  await until(() => preview.fixturePreferences(a).conversations[1].title === "账户 A 的备注", "saved conversation alias");
  await wait("document.querySelectorAll('#conversation-label-list .conversation-item')[1].querySelector('input').value==='账户 A 的备注' && !document.querySelectorAll('#conversation-label-list .conversation-item')[1].querySelector('button').disabled", "refreshed saved row");
  await js("document.querySelectorAll('#conversation-label-list .conversation-item')[1].querySelectorAll('button')[1].click()");
  await until(() => preview.fixturePreferences(a).conversations[1].pinned, "saved conversation pin");
  await wait("document.querySelectorAll('#conversation-label-list .conversation-item')[1].querySelectorAll('button')[1].textContent==='取消保留'", "refreshed pin row");
  const beforeA = preview.fixturePreferences(a).conversations, beforeB = preview.fixturePreferences(b).conversations;
  const beforeWrites = conversationWrites().length;
  assert.equal(beforeWrites, 2, "positive controls must dispatch both row actions");
  await js("(()=>{const row=document.querySelectorAll('#conversation-label-list .conversation-item')[1];window.__oldConversation={row,save:row.querySelectorAll('button')[0],pin:row.querySelectorAll('button')[1]};row.querySelector('input').value='旧行越界写入';})()");
  await click("#btn-clear-conversations");
  await wait("document.querySelector('#dlg-confirm').open", "account A clear confirmation");
  await switchAccount(b);
  assert.equal(await js("document.querySelector('#dlg-conversations').open"), false);
  assert.equal(await js("document.querySelector('#conversation-label-list').children.length"), 0);
  assert.equal(await js("window.__oldConversation.row.isConnected"), false);
  await js("window.__oldConversation.save.click();window.__oldConversation.pin.click()");
  await wait("document.querySelector('#toast').textContent.includes('账户已切换')", "stale row action rejected");
  assert.equal(conversationWrites().length, beforeWrites, "detached A actions must not issue rename/pin IPC against B");
  assert.deepEqual(preview.fixturePreferences(a).conversations, beforeA);
  assert.deepEqual(preview.fixturePreferences(b).conversations, beforeB);
  pass("detached old-account Save and Pin handlers reject before IPC after switching accounts");

  if (await js("document.querySelector('#dlg-confirm').open")) {
    await click("#confirm-ok");
    await wait("!document.querySelector('#dlg-confirm').open", "old confirmation accepted");
    assert.equal(await js("document.querySelector('#dlg-confirm').returnValue"), "ok");
  }
  await pause(80);
  assert.equal(conversationWrites().length, beforeWrites, "an A confirmation must not clear B");
  assert.deepEqual(preview.fixturePreferences(a).conversations, beforeA);
  assert.deepEqual(preview.fixturePreferences(b).conversations, beforeB);
  await openConversations();
  await click("#btn-clear-conversations");
  await wait("document.querySelector('#dlg-confirm').open", "account B clear confirmation");
  await click("#confirm-ok");
  await until(() => preview.fixturePreferences(b).conversations.length === 1, "legitimate B clear");
  const clearCalls = preview.calls().filter(call => call.channel === "conversations:clearInactive");
  assert.equal(clearCalls.length, 1); assert.equal(clearCalls[0].accountId, b);
  assert.ok(preview.fixturePreferences(b).conversations.every(row => row.pinned));
  assert.deepEqual(preview.fixturePreferences(a).conversations, beforeA);
  await js("document.querySelector('#dlg-conversations').close()");
  pass("clear confirmation stays bound to its original account while a fresh B confirmation clears only B unpinned rows");

  await wait("!document.querySelector('#sound-choice-trigger').disabled", "B sound picker ready");
  const soundReads = preview.calls().filter(call => call.channel === "notification:sounds").length;
  preview.fail("notification:sounds");
  await chooseSound("digital");
  await wait("document.querySelector('#toast').classList.contains('error') && document.querySelector('#toast').textContent.includes('预览注入')", "injected sound refresh failure surfaced");
  assert.equal(preview.calls().filter(call => call.channel === "notification:sounds").length, soundReads + 1);
  assert.equal(preview.fixturePreferences(b).sounds.selected, "digital", "the save succeeded before the injected refresh failure");
  assert.equal(await js("document.querySelector('#sound-choice').disabled"), false);
  assert.equal(await js("document.querySelector('#sound-choice-trigger').disabled"), false, "failed refresh must not strand the visible picker disabled");
  await chooseSound("xylophone");
  await until(() => preview.fixturePreferences(b).sounds.selected === "xylophone", "sound choice after failed refresh");
  await wait("!document.querySelector('#sound-choice-trigger').disabled", "recovered sound picker");
  assert.deepEqual(preview.fixturePreferences(a).sounds, { selected: "bells", volume: 60, hasCustom: true });
  assert.equal(preview.snapshot(a).config.idleReminderMinutes, 10);
  assert.equal(preview.snapshot(b).config.idleReminderMinutes, 5);
  assert.deepEqual(await js("window.__preferencesErrors"), []);
  assert.equal(preview.calls().some(call => /^(services:|mcp:start|mcp:restart|mcp:stop|tunnel:start|tunnel:stop|setup:run)/.test(call.channel)), false);
  pass("a failed notification:sounds refresh reports an error, unlocks the visible picker and permits a subsequent selection");

  const outcomes = [
    ["needs_input", "REQUIREMENT_CONTRACT_INVALID", "admission", false, "retry_with_changed_args", "参数待修正"],
    ["review_rejected", "VISUAL_REVIEW_REJECTED", "postprocessing", true, "repair_then_review", "评审未通过"],
    ["blocked", "POLICY_DENIED", "admission", false, "none", "未执行"],
    ["execution_error", "COMMAND_EXIT_NONZERO", "execution", true, "inspect_original_result", "失败"]
  ].map(([kind, code, phase, started, retry, label], index) => ({ kind, code, phase, started, retry, label, callId: "prefs-outcome-" + kind, summary: "回归样例 " + (index + 1), ms: index + 2 }));
  preview.append("mcp", outcomes.map(row => "[TOOL] [running] run_command — " + row.summary + " 0ms call=" + row.callId), b);
  await wait("(()=>{const calls=window.__harness.core.snapshot().activity.filter(row=>row.callId?.startsWith('prefs-outcome-'));return calls.length===4&&calls.every(row=>row.phase==='running');})()", "four concurrent calls of the same tool");
  preview.append("mcp", [3, 1, 0, 2].map(index => {
    const row = outcomes[index];
    return "[TOOL] [error] run_command — " + row.summary + " " + row.ms + "ms outcome=" + row.kind + " code=" + row.code + " phase=" + row.phase + " started=" + row.started + " retry=" + row.retry + " call=" + row.callId;
  }), b);
  await js("window.__harness.setView('logs')");
  await wait("document.querySelectorAll('.ev-call.failed[data-call^=prefs-outcome-] .res').length===4", "four separate canonical terminal rows");
  logOutcomes.push(...await js("[...document.querySelectorAll('.ev-call[data-call^=prefs-outcome-]')].map(row=>({callId:row.dataset.call,tool:row.dataset.tool,outcome:row.dataset.outcome,result:row.querySelector('.res').textContent,say:row.querySelector('.say').textContent}))"));
  assert.equal(logOutcomes.length, 4);
  for (const expected of outcomes) {
    const observed = logOutcomes.find(row => row.callId === expected.callId);
    assert.ok(observed, "each concurrent call retains its own identity");
    assert.equal(observed.tool, "run_command");
    assert.equal(observed.outcome, expected.kind);
    assert.equal(observed.result, "，" + expected.label);
    assert.ok(observed.say.includes(expected.summary));
    assert.doesNotMatch(observed.say, /(?:outcome|code|phase|started|retry|call)=/, "diagnostic tokens must not leak into narrative copy");
    assert.ok(!observed.say.includes(expected.callId));
  }
  await pause(250);
  const screenshot = path.join(output, "canonical-outcomes.png");
  fs.writeFileSync(screenshot, (await win.capturePage()).toPNG()); screenshots.push(screenshot);
  assert.deepEqual(await js("window.__preferencesErrors"), []);
  pass("four concurrent canonical failures render distinct user labels without leaking metadata into narrative text");

  await js("window.__harness.setView('workspace')");
  await wait("document.querySelectorAll('#history li[data-call^=prefs-outcome-] .result').length===4 && !document.querySelector('#view-workspace').classList.contains('entering')", "four canonical outcomes in visible workspace history");
  historyOutcomes.push(...await js("[...document.querySelectorAll('#history li[data-call^=prefs-outcome-]')].map(row=>({callId:row.dataset.call,resultCount:row.querySelectorAll('.result').length,result:row.querySelector('.result').textContent,say:row.querySelector('.w').textContent,after:getComputedStyle(row.querySelector('.w'),'::after').content}))"));
  assert.equal(historyOutcomes.length, 4);
  for (const expected of outcomes) {
    const observed = historyOutcomes.find(row => row.callId === expected.callId);
    assert.ok(observed, "workspace must retain each canonical call identity");
    assert.equal(observed.resultCount, 1);
    assert.equal(observed.result, "，" + expected.label);
    assert.equal(observed.say.split(expected.label).length - 1, 1, "workspace must display each outcome once");
    assert.ok(observed.say.includes(expected.summary));
    assert.ok(["none", "normal", '\"\"', "''"].includes(observed.after), "real Aura CSS must not append generic failure text: " + observed.after);
  }
  const historyScreenshot = path.join(output, "canonical-history-outcomes.png");
  fs.writeFileSync(historyScreenshot, (await win.capturePage()).toPNG()); screenshots.push(historyScreenshot);
  pass("workspace renders each canonical outcome once and real Aura CSS adds no generic failure suffix");
  finish();
})().catch(finish);
