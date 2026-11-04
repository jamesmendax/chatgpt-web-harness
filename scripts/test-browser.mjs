import fs from "fs/promises";
import assert from "node:assert/strict";
import path from "path";
import os from "node:os";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../dist/server-factory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
process.env.CHATGPT_TOOL_PROFILE = "full";
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wh-browser-test-"));
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(tmpDir, "checkpoint-home");
const htmlPath = path.join(tmpDir, "browser.html");
await fs.writeFile(
  htmlPath,
  `<!doctype html><html><body><input id="name"><button id="go">Go</button><div id="out"></div><script>
  document.querySelector('#go').addEventListener('click',()=>{const v=document.querySelector('#name').value;document.querySelector('#out').textContent='Hello '+v;console.error('qa-marker:'+v)});
  </script></body></html>`
);

function requireImage(result, label) {
  const block = result.content?.find((item) => item.type === "image");
  if (!block?.data) throw new Error(`${label}: image block missing: ${JSON.stringify(result.structuredContent ?? result.content).slice(0, 1500)}`);
}

const server = createMcpServer(tmpDir, 30_000, [tmpDir], true);
const client = new Client({ name: "browser-test-client", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated browser session and turn-fence fixtures",
  scope: ["temporary local browser fixture created by this test"],
  out_of_scope: [],
  deliverables: ["browser action, turn fence, diagnostics, and cleanup assertions"],
  success_criteria: ["the isolated browser session can be opened, mutated, observed, and closed deterministically"],
  constraints: [], protected_resources: [], known_facts: ["the browser session is test-owned and local"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});

function callTool(request) {
  const args = request?.arguments ?? {};
  const readOnlyBrowserAction = request?.name === "browser_action" && ["turn_observe", "wait"].includes(args.action);
  const needsIntent = ["browser_open", "browser_close", "browser_action"].includes(request?.name) && !readOnlyBrowserAction;
  return client.callTool(needsIntent
    ? { ...request, arguments: { ...args, _intent: TEST_INTENT } }
    : request);
}

let sessionId;
try {
  const opened = await callTool({ name: "browser_open", arguments: { target: htmlPath, width: 800, height: 500 } });
  requireImage(opened, "browser_open");
  sessionId = opened.structuredContent?.data?.session_id;
  if (!sessionId) throw new Error("browser_open: session_id missing");

  const filled = await callTool({
    name: "browser_action",
    arguments: { session_id: sessionId, action: "fill", selector: "#name", text: "CodexLoop", screenshot: false },
  });
  if (!filled.structuredContent?.ok) throw new Error("fill failed");

  const clicked = await callTool({
    name: "browser_action",
    arguments: { session_id: sessionId, action: "click", selector: "#go", screenshot: true },
  });
  requireImage(clicked, "browser_action click");
  const excerpt = clicked.structuredContent?.data?.text_excerpt || "";
  if (!String(excerpt).includes("Hello CodexLoop")) throw new Error(`DOM state not updated: ${excerpt}`);
  const errors = clicked.structuredContent?.data?.console_errors || [];
  if (!JSON.stringify(errors).includes("qa-marker:CodexLoop")) throw new Error("console diagnostics missing");

  const evaluated = await callTool({
    name: "browser_action",
    arguments: { session_id: sessionId, action: "evaluate", script: "document.querySelector('#out').textContent", screenshot: false },
  });
  if (evaluated.structuredContent?.data?.action_result !== "Hello CodexLoop") throw new Error("evaluate returned wrong value");

  const action = (args) => callTool({ name: "browser_action", arguments: { session_id: sessionId, screenshot: false, ...args } });
  await action({ action: "evaluate", script: `
    window.sendCount = 0;
    const send = document.createElement('button'); send.id = 'send'; send.textContent = 'Send';
    send.onclick = () => {
      window.sendCount++;
      for (const kind of ['user', 'assistant']) {
        const turn = document.createElement('p'); turn.className = 'turn-' + kind;
        turn.textContent = kind; document.body.append(turn);
      }
      document.querySelector('#out').textContent = 'Reply ' + window.sendCount;
    }; document.body.append(send);` });
  const sendArgs = { action: "turn_send", selector: "#send", user_turn_selector: ".turn-user", assistant_turn_selector: ".turn-assistant", generation_selector: ".generating", visible_text_selector: "#out", stable_ms: 100 };
  await action({ action: "evaluate", script: `
    const existing = document.createElement('div'); existing.id='existing-delivery-error';
    existing.textContent='ChatGPT stream recovery polling timed out';
    const retry = document.createElement('button'); retry.textContent='Retry'; existing.append(retry); document.body.append(existing);` });
  assert.equal((await action(sendArgs)).isError, true, "an already-failed page must block send activation before any click");
  assert.equal((await action({ action: "evaluate", script: "window.sendCount" })).structuredContent.data.action_result, 0);
  await action({ action: "evaluate", script: "document.querySelector('#existing-delivery-error').remove()" });
  const racingSends = await Promise.all([action(sendArgs), action(sendArgs)]);
  assert.equal(racingSends.filter(result => result.structuredContent?.ok).length, 1, "only one concurrent send may activate");
  assert.equal((await action(sendArgs)).isError, true, "unconfirmed send must not be resubmitted");
  assert.equal((await action({ action: "evaluate", script: "window.sendCount" })).structuredContent.data.action_result, 1);
  const observed = await action({ action: "turn_observe" });
  assert.equal(observed.structuredContent.data.action_result.phase, "candidate_complete");
  await action({ action: "evaluate", script: `
    const failure = document.createElement('div'); failure.id = 'native-failure'; failure.setAttribute('role', 'alert');
    failure.textContent = 'ChatGPT stream recovery polling timed out';
    const retry = document.createElement('button'); retry.textContent = 'Retry'; failure.append(retry); document.body.append(failure);` });
  for (let count = 0; count < 2; count++) {
    const failed = (await action({ action: "turn_observe" })).structuredContent.data.action_result;
    assert.equal(failed.phase, "delivery_failed", "the DOM producer must propagate the native error into the fence");
    assert.equal(failed.current.failure_visible, true);
    assert.equal(failed.completed, false);
    assert.equal(failed.resubmit_allowed, false);
  }
  assert.equal((await action(sendArgs)).isError, true, "delivery failure must not permit a second send");
  await action({ action: "evaluate", script: "document.querySelector('#native-failure').style.display='none'; document.querySelector('#out').textContent='Error UI cleared';" });
  const cleared = (await action({ action: "turn_observe" })).structuredContent.data.action_result;
  assert.equal(cleared.current.failure_visible, false);
  assert.equal(cleared.phase, "delivery_failed", "banner clearance is not a final answer");
  await action({ action: "evaluate", script: "const active=document.createElement('div'); active.className='generating'; active.textContent='Working'; document.body.append(active);" });
  assert.equal((await action({ action: "turn_observe" })).structuredContent.data.action_result.phase, "running");
  await action({ action: "evaluate", script: "document.querySelector('.generating').remove(); const reply=document.createElement('p'); reply.className='turn-assistant'; reply.textContent='New response'; document.body.append(reply); document.querySelector('#out').textContent='Fresh real answer';" });
  assert.equal((await action({ action: "turn_observe" })).structuredContent.data.action_result.phase, "candidate_complete");
  await action({ action: "wait", milliseconds: 150 });
  assert.equal((await action({ action: "turn_observe" })).structuredContent.data.action_result.phase, "complete");

  await action({ action: "evaluate", script: `
    const quoted = document.createElement('p'); quoted.setAttribute('data-message-author-role', 'user');
    quoted.textContent = 'We discussed ChatGPT stream recovery polling timed out'; document.body.append(quoted);
    const retry = document.createElement('button'); retry.textContent = 'Retry'; document.body.append(retry);
    const custom = document.createElement('div'); custom.id = 'custom-failure'; custom.style.display='none';
    custom.textContent='Fixture transport unavailable'; document.body.append(custom);` });
  assert.equal((await action({ action: "turn_observe" })).structuredContent.data.action_result.current.failure_visible, false,
    "a hidden alert or quoted error with an unrelated Retry must not be a live failure");
  const customSend = await action({ ...sendArgs, failure_selector: "#custom-failure" });
  assert.equal(customSend.structuredContent.ok, true);
  await action({ action: "evaluate", script: "document.querySelector('#custom-failure').style.display='block'" });
  const customFailed = (await action({ action: "turn_observe" })).structuredContent.data.action_result;
  assert.equal(customFailed.current.failure_visible, true, "caller-provided error UI selector must be observed");
  assert.equal(customFailed.phase, "delivery_failed");
  assert.equal((await action(sendArgs)).isError, true);
  await action({ action: "evaluate", script: "document.querySelector('#out').remove()" });
  const unreadable = await action({ action: "turn_observe" });
  assert.equal(unreadable.isError, true, "unreadable DOM must remain unknown instead of proving idle completion");
  assert.equal((await action(sendArgs)).isError, true, "DOM failure must preserve the original send fence");

  const closed = await callTool({ name: "browser_close", arguments: { session_id: sessionId } });
  if (!closed.structuredContent?.data?.closed || closed.structuredContent?.data?.active_sessions !== 0) {
    throw new Error("browser session did not close cleanly");
  }

  console.log("OK isolated browser session, native/custom failure propagation, clearance latch, no-resubmit, unreadable DOM, image/console and resource cleanup");
} finally {
  if (sessionId) await callTool({ name: "browser_close", arguments: { session_id: sessionId } }).catch(() => {});
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  await fs.rm(tmpDir, { recursive: true, force: true });
}
