"use strict";

// Pure Node, in-memory DOM/IPC harness. No Electron, files written, accounts, or services.
// Optional pre-fix replay: node desktop/scripts/test-renderer-runtime.cjs --source-ref=<git-ref>
// This is not a layout engine: scroll assignments and DOM identity/work are checked, not pixels.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
const sourceRef = process.argv.find((arg) => arg.startsWith("--source-ref="))?.slice(13);
const source = sourceRef
  ? execFileSync("git", ["show", sourceRef + ":desktop/renderer/app.js"], { cwd: path.join(__dirname, "../.."), encoding: "utf8", windowsHide: true })
  : fs.readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8");
assert.match(source, /\ninit\(\);\s*$/);
const json = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(setImmediate); // Drain IPC microtasks without timing sleeps.

function makeDOM() {
  const metrics = { created: 0, logAppends: 0, logRemoves: 0, logClears: 0, scrollReads: 0, scrollWrites: 0 };
  function matches(node, part) {
    if (part.startsWith("#")) return node.id === part.slice(1);
    if (part.startsWith(".")) return node.className.split(/\s+/).includes(part.slice(1));
    const attr = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const value = attr[1].startsWith("data-") ? node.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : node[attr[1]];
      return attr[2] === undefined ? value !== undefined : value === attr[2];
    }
    assert.match(part, /^[a-z][\w-]*$/, "Unsupported harness selector");
    return node.tagName === part.toUpperCase();
  }
  class Node {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.nodeType = tagName === "#fragment" ? 11 : tagName === "#text" ? 3 : 1;
      this.childNodes = [];
      this.parentNode = null;
      this.dataset = {};
      this.className = "";
      this.value = "";
      this.checked = this.disabled = this.hidden = false;
      this._text = "";
      this._scrollTop = 0;
      this.listeners = new Map();
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        toggle: (name, force) => {
          const classes = new Set(this.className.split(/\s+/).filter(Boolean));
          const on = force === undefined ? !classes.has(name) : force;
          if (on) classes.add(name); else classes.delete(name);
          this.className = [...classes].join(" ");
          return on;
        },
        add: (name) => this.classList.toggle(name, true),
        remove: (name) => this.classList.toggle(name, false),
      };
    }
    get firstChild() { return this.childNodes[0] || null; }
    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
    get textContent() { return this._text + this.childNodes.map((child) => child.textContent).join(""); }
    set textContent(value) {
      if (this.id === "log-view") { metrics.logClears++; this._scrollTop = 0; }
      for (const child of [...this.childNodes]) this.removeChild(child);
      this._text = String(value);
    }
    set innerHTML(value) {
      assert.equal(value, "", "Harness forbids HTML injection; use textContent/createElement");
      this.textContent = "";
    }
    get scrollHeight() { if (this.id === "log-view") metrics.scrollReads++; return this.childNodes.length * 20; }
    get scrollTop() { return this._scrollTop; }
    set scrollTop(value) { if (this.id === "log-view") metrics.scrollWrites++; this._scrollTop = value; }
    appendChild(child) {
      if (child.nodeType === 11) {
        for (const item of [...child.childNodes]) this.appendChild(item);
        return child;
      }
      if (child.parentNode) child.parentNode.removeChild(child);
      this.childNodes.push(child);
      child.parentNode = this;
      if (this.id === "log-view") metrics.logAppends++;
      return child;
    }
    append(...children) { for (const child of children) this.appendChild(child); }
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      assert.notEqual(index, -1);
      this.childNodes.splice(index, 1);
      child.parentNode = null;
      if (child.contains(document.activeElement)) document.activeElement = null;
      if (this.id === "log-view") metrics.logRemoves++;
      return child;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(node) { return this === node || this.childNodes.some((child) => child.contains(node)); }
    focus() { document.activeElement = this; }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    async fire(type) {
      const event = { type, target: this, preventDefault() {} };
      for (const handler of this.listeners.get(type) || []) await handler(event);
    }
    querySelectorAll(selector) {
      const parts = selector.trim().split(/\s+/);
      const out = [];
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (matches(child, parts.at(-1))) {
            let ancestor = child.parentNode;
            let index = parts.length - 2;
            while (ancestor && index >= 0) {
              if (matches(ancestor, parts[index])) index--;
              ancestor = ancestor.parentNode;
            }
            if (index < 0) out.push(child);
          }
          visit(child);
        }
      };
      visit(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const document = new Node("document");
  document.activeElement = null;
  document.createElement = (tag) => { metrics.created++; return new Node(tag); };
  document.createDocumentFragment = () => new Node("#fragment");
  document.getElementById = (id) => {
    const node = document.querySelector("#" + id);
    assert.ok(node, "Missing renderer element: " + id);
    return node;
  };
  const stack = [document];
  const voidTags = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);
  for (const token of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<\/?([\w-]+)\b([^>]*?)\/?>|([^<]+)/g)) {
    if (token[3]) {
      const text = new Node("#text");
      text._text = token[3];
      stack.at(-1).appendChild(text);
    } else if (token[0].startsWith("</")) {
      assert.equal(stack.at(-1).tagName, token[1].toUpperCase(), "Fixture HTML must be balanced");
      stack.pop();
    } else {
      const node = new Node(token[1]);
      for (const attr of token[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) {
        const value = attr[2] ?? attr[3] ?? "";
        if (attr[1] === "class") node.className = value;
        else if (attr[1].startsWith("data-")) node.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
        else node[attr[1]] = ["checked", "disabled", "hidden"].includes(attr[1]) ? true : value;
      }
      stack.at(-1).appendChild(node);
      if (!voidTags.has(node.tagName) && !token[0].endsWith("/>")) stack.push(node);
    }
  }
  assert.equal(stack.length, 1);
  const resetMetrics = () => { for (const key of Object.keys(metrics)) metrics[key] = 0; };
  resetMetrics();
  return { document, metrics, resetMetrics };
}

function skill(id, extra = {}) {
  return { id, path: "D:/fixture/" + id + "/SKILL.md", enabled: true, description: id + " description", ...extra };
}
function catalog(extra = {}) {
  return {
    installed: [skill("installed-one")], builtin: [skill("builtin-one")],
    external: [skill("external-one"), skill("external-two")],
    project: [skill("project-one", { source: "project" })],
    computerUse: { enabled: false, available: true },
    browserUse: { enabled: false, available: true, runtimeReady: true },
    configPath: "D:/fixture/plugins.json", ...extra,
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(handlers = {}, { bind = true } = {}) {
  const dom = makeDOM();
  const events = new Map();
  const calls = [];
  const defaultAccounts = () => ({
    selectedId: "default",
    maxAccounts: 16,
    securityBoundary: "运行配置档隔离；不是 Windows 用户或系统安全沙箱",
    accounts: [{
      id: "default", name: "默认账号（原配置）", dataDir: "D:/fixture/user-data",
      config: { setupDone: true, mcpPort: 3000, adminPort: 3001, tunnelPort: 8080, workspacePath: "D:/fixture/workspace" },
      mcp: { state: "stopped", pid: null, owned: false },
      tunnel: { state: "stopped", pid: null, owned: false, cloudState: "unknown" },
      busy: false, lastError: "",
    }],
  });
  const methods = { getSkillCatalog: () => catalog(), listAccounts: defaultAccounts, ...handlers };
  const launcher = new Proxy({ on: (name, handler) => events.set(name, handler) }, {
    get(target, name) {
      if (name in target) return target[name];
      return async (payload) => {
        calls.push({ name, payload: payload === undefined ? undefined : json(payload) });
        assert.equal(typeof methods[name], "function", "Unexpected launcher call: " + name);
        return { ok: true, result: await methods[name](payload) };
      };
    },
  });
  const context = vm.createContext({ document: dom.document, launcher, console, confirm: () => true, prompt: () => null, setTimeout: () => 0 });
  vm.runInContext(source.replace(/\ninit\(\);\s*$/, "\n"), context, { filename: "renderer/app.js" });
  const run = (code) => vm.runInContext(code, context);
  if (bind) run("bind()");
  return {
    ...dom, run, context, calls, methods,
    node: (id) => dom.document.getElementById(id),
    emit: (name, payload) => { assert.ok(events.has(name)); return events.get(name)(payload); },
    registrations: () => json(run("collectRegistrations()")),
  };
}
const rows = (h) => h.node("registered-skills-list").querySelectorAll(".skill-row");
const nameInput = (row) => row.querySelector('[data-field="name"]');
const enabledInput = (row) => row.querySelector('[data-field="enabled"]');
function logBatch(h, name, count, start = 0) {
  h.emit("log", Array.from({ length: count }, (_, index) => ({ name, line: name + " line " + (start + index) })));
}
async function addRegistration(h, id) {
  h.node("f-skill-name").value = id;
  h.node("f-skill-path").value = "D:/fixture/" + id + "/SKILL.md";
  await h.node("btn-add-skill").fire("click");
}

test("catalog renders installed, builtin, external, and discovered sections", async () => {
  const h = harness();
  await h.run("loadSkillCatalog()");
  for (const [id, expected] of [["installed-skills-list", "installed-one"], ["builtin-skills-list", "builtin-one"], ["project-skills-list", "project-one"]]) {
    assert.match(h.node(id).textContent, new RegExp(expected));
    assert.equal(h.node(id).querySelectorAll(".skill-row").length, 1);
  }
  assert.equal(rows(h).length, 2);
  assert.equal(nameInput(rows(h)[0]).value, "external-one");
});

test("visible logs append rather than rebuild; cap, literal text, and autoscroll remain", () => {
  const h = harness();
  h.run('renderLog("mcp")');
  logBatch(h, "mcp", 3000);
  const survivor = h.node("log-view").childNodes[1];
  h.resetMetrics();
  h.emit("log", [{ name: "mcp", line: "12:00:00 ! <script>error</script>" }]);
  assert.equal(h.metrics.created, 1);
  assert.equal(h.metrics.logClears, 0);
  assert.equal(h.node("log-view").firstChild, survivor);
  assert.equal(h.node("log-view").childNodes.length, 3000);
  assert.equal(h.run("state.logs.mcp.length"), 3000);
  const last = h.node("log-view").childNodes.at(-1);
  assert.equal(last.className, "err");
  assert.equal(last.textContent, "12:00:00 ! <script>error</script>\n");
  assert.equal(h.node("log-view").scrollTop, h.node("log-view").scrollHeight);
  h.node("log-autoscroll").checked = false;
  h.node("log-view").scrollTop = 40;
  logBatch(h, "mcp", 1, 3001);
  assert.equal(h.node("log-view").scrollTop, 40);
});

test("hidden dashboard buffers logs with no DOM work and catches up once", async (t) => {
  const h = harness();
  h.run('renderLog("mcp"); showView("skills")');
  await settle();
  h.resetMetrics();
  for (let batch = 0; batch < 100; batch++) logBatch(h, "mcp", 10, batch * 10);
  t.diagnostic("100 hidden log batches / 1000 lines: created=" + h.metrics.created + ", appends=" + h.metrics.logAppends + ", scroll reads=" + h.metrics.scrollReads);
  assert.equal(h.run("state.logs.mcp.length"), 1000);
  assert.equal(h.metrics.created, 0);
  assert.equal(h.metrics.logAppends, 0);
  assert.equal(h.metrics.scrollReads, 0);
  assert.equal(h.metrics.scrollWrites, 0);
  h.run('showView("dashboard")');
  assert.equal(h.node("log-view").childNodes.length, 1000);
  assert.equal(h.node("log-view").childNodes.at(-1).textContent, "mcp line 999\n");
  assert.equal(h.node("log-view").scrollTop, h.node("log-view").scrollHeight);
  const first = h.node("log-view").firstChild;
  h.resetMetrics();
  h.run('showView("settings"); showView("dashboard")');
  assert.equal(h.node("log-view").firstChild, first);
  assert.equal(h.metrics.logClears, 0);
});

test("refresh response cannot replace registrations edited, added, or removed while awaiting IPC", async (t) => {
  const pending = deferred();
  const h = harness();
  await h.run("loadSkillCatalog()");
  h.methods.getSkillCatalog = () => pending.promise;
  const refresh = h.run("loadSkillCatalog()");
  const first = rows(h)[0];
  const input = nameInput(first);
  input.focus();
  input.value = "draft name ";
  enabledInput(first).checked = false;
  await rows(h)[1].querySelector("button").fire("click");
  await addRegistration(h, "draft-added");
  const before = h.registrations();
  pending.resolve(catalog({ installed: [skill("installed-new")] }));
  await refresh;
  t.diagnostic("registration ids after delayed refresh: " + h.registrations().map((item) => item.id).join(", "));
  assert.deepEqual(h.registrations(), before);
  assert.equal(rows(h)[0], first);
  assert.equal(nameInput(first).value, "draft name ");
  assert.equal(h.document.activeElement, input);
  assert.match(h.node("installed-skills-list").textContent, /installed-new/);
});

test("installed toggle keeps existing unsaved external registration DOM", async () => {
  const h = harness({ setSkillEnabled: () => ({ catalog: catalog({ installed: [skill("installed-one", { enabled: false })] }) }) });
  await h.run("loadSkillCatalog()");
  nameInput(rows(h)[0]).value = "unsaved-name";
  await addRegistration(h, "unsaved-added");
  const beforeRows = rows(h);
  const before = h.registrations();
  const toggle = h.node("installed-skills-list").querySelector("input");
  toggle.checked = false;
  await toggle.fire("change");
  assert.deepEqual(h.registrations(), before);
  assert.deepEqual(rows(h), beforeRows);
  assert.equal(h.node("installed-skills-list").querySelector("input").checked, false);
});


test("hidden buffers stay capped; return without autoscroll preserves scroll position", () => {
  const h = harness();
  h.run('renderLog("mcp")');
  logBatch(h, "mcp", 50);
  h.node("log-autoscroll").checked = false;
  h.node("log-view").scrollTop = 120;
  h.run('showView("settings")');
  h.resetMetrics();
  logBatch(h, "mcp", 3500, 50);
  logBatch(h, "tunnel", 3500);
  assert.equal(h.run("state.logs.mcp.length"), 3000);
  assert.equal(h.run("state.logs.tunnel.length"), 3000);
  assert.equal(h.metrics.created, 0);
  assert.equal(h.metrics.logClears, 0);
  h.run('showView("dashboard")');
  assert.equal(h.node("log-view").childNodes.length, 3000);
  assert.equal(h.node("log-view").firstChild.textContent, "mcp line 550\n");
  assert.equal(h.node("log-view").childNodes.at(-1).textContent, "mcp line 3549\n");
  assert.equal(h.node("log-view").scrollTop, 120);
  logBatch(h, "mcp", 1, 3550);
  assert.equal(h.node("log-view").childNodes.length, 3000);
  assert.equal(h.node("log-view").childNodes.at(-1).textContent, "mcp line 3550\n");
});

test("log tabs, hints, open-file action and clearing only the selected buffer still work", async () => {
  const h = harness({ clearLogs: () => true, openLogFile: () => true });
  h.run('renderLog("mcp")');
  logBatch(h, "mcp", 2);
  logBatch(h, "tunnel", 3);
  logBatch(h, "launcher", 1);
  assert.equal(h.node("log-view").childNodes.length, 2);
  await h.document.querySelector('[data-log="tunnel"]').fire("click");
  assert.equal(h.node("log-view").childNodes.length, 3);
  assert.match(h.node("log-hint").textContent, /tunnel-client/);
  assert.equal(h.node("btn-open-log-file").disabled, false);
  await h.node("btn-open-log-file").fire("click");
  assert.deepEqual(h.calls.at(-1), { name: "openLogFile", payload: { name: "tunnel" } });
  await h.node("btn-clear-log").fire("click");
  assert.deepEqual(h.calls.at(-1), { name: "clearLogs", payload: { name: "tunnel" } });
  assert.equal(h.node("log-view").childNodes.length, 0);
  assert.equal(h.run("state.logs.tunnel.length"), 0);
  assert.equal(h.run("state.logs.mcp.length"), 2);
  logBatch(h, "tunnel", 1, 3);
  assert.equal(h.node("log-view").textContent, "tunnel line 3\n");
  await h.document.querySelector('[data-log="launcher"]').fire("click");
  assert.equal(h.node("btn-open-log-file").disabled, true);
  assert.equal(h.node("log-view").textContent, "launcher line 0\n");
  h.node("log-autoscroll").checked = false;
  await h.document.querySelector('[data-log="mcp"]').fire("click");
  assert.equal(h.node("log-view").scrollTop, h.node("log-view").scrollHeight, "Explicit log switches still start at the bottom");
});

test("out-of-order refresh responses do not roll back a newer catalog", async () => {
  const older = deferred(), newer = deferred();
  const h = harness();
  await h.run("loadSkillCatalog()");
  h.methods.getSkillCatalog = () => older.promise;
  const first = h.run("loadSkillCatalog()");
  h.methods.getSkillCatalog = () => newer.promise;
  const second = h.run("loadSkillCatalog()");
  newer.resolve(catalog({ external: [skill("newer-response")] }));
  await second;
  const row = rows(h)[0];
  older.resolve(catalog({ external: [skill("older-response")] }));
  await first;
  assert.equal(nameInput(rows(h)[0]).value, "newer-response");
  assert.equal(rows(h)[0], row);
});

test("refresh begun before an accepted installed toggle cannot undo that mutation", async () => {
  const pending = deferred();
  const h = harness({ setSkillEnabled: () => ({ catalog: catalog({ installed: [skill("installed-one", { enabled: false })] }) }) });
  await h.run("loadSkillCatalog()");
  h.methods.getSkillCatalog = () => pending.promise;
  const refresh = h.run("loadSkillCatalog()");
  const toggle = h.node("installed-skills-list").querySelector("input");
  toggle.checked = false;
  await toggle.fire("change");
  pending.resolve(catalog());
  await refresh;
  assert.equal(h.node("installed-skills-list").querySelector("input").checked, false);
});

test("refresh preserves removal of every external row and a pending Computer Use edit", async () => {
  const pending = deferred(), pendingToggle = deferred();
  const h = harness({ setComputerUseEnabled: () => pendingToggle.promise });
  await h.run("loadSkillCatalog()");
  h.methods.getSkillCatalog = () => pending.promise;
  const refresh = h.run("loadSkillCatalog()");
  for (const row of rows(h)) await row.querySelector("button").fire("click");
  h.node("chk-computer-use").checked = true;
  const toggle = h.node("chk-computer-use").fire("change");
  pending.resolve(catalog());
  await refresh;
  assert.equal(rows(h).length, 0);
  assert.match(h.node("registered-skills-list").textContent, /清空/);
  assert.equal(h.node("chk-computer-use").checked, true);
  pendingToggle.resolve({ catalog: catalog({ computerUse: { enabled: true, available: true } }) });
  await toggle;
});

test("manual refresh still replaces pre-request drafts if nothing is edited during the request", async () => {
  const h = harness();
  await h.run("loadSkillCatalog()");
  nameInput(rows(h)[0]).value = "discard-on-explicit-refresh";
  await h.node("btn-skills-refresh").fire("click");
  // The production click handler starts the request but does not return its promise.
  await settle();
  assert.equal(nameInput(rows(h)[0]).value, "external-one");
});

test("saving a submitted snapshot does not discard edits made while awaiting its response", async () => {
  const pending = deferred();
  const h = harness({ saveSkillCatalog: () => pending.promise });
  await h.run("loadSkillCatalog()");
  nameInput(rows(h)[0]).value = "submitted-name";
  const save = h.node("btn-skills-save").fire("click");
  assert.equal(h.node("btn-skills-save").disabled, true);
  assert.equal(h.calls.at(-1).payload.registrations[0].id, "submitted-name");
  const row = rows(h)[0];
  nameInput(row).value = "newer-draft";
  await addRegistration(h, "newer-added");
  const before = h.registrations();
  pending.resolve({ catalog: catalog({ external: [skill("submitted-name"), skill("external-two")] }) });
  await save;
  assert.deepEqual(h.registrations(), before);
  assert.equal(rows(h)[0], row);
  assert.equal(h.node("btn-skills-save").disabled, false);
  assert.match(h.node("toasts").textContent, /后续编辑尚未保存/);
});

test("unchanged save applies canonical catalog metadata and failed save leaves draft editable", async () => {
  const h = harness({ saveSkillCatalog: () => ({ catalog: catalog({ external: [skill("canonical-id")] }) }) });
  await h.run("loadSkillCatalog()");
  await h.node("btn-skills-save").fire("click");
  assert.equal(nameInput(rows(h)[0]).value, "canonical-id");
  assert.match(rows(h)[0].textContent, /canonical-id description/);
  const row = rows(h)[0];
  nameInput(row).value = "retry-this";
  h.methods.saveSkillCatalog = () => { throw new Error("fixture failure"); };
  await h.node("btn-skills-save").fire("click");
  assert.equal(rows(h)[0], row);
  assert.equal(nameInput(row).value, "retry-this");
  assert.equal(h.node("btn-skills-save").disabled, false);
  assert.match(h.node("toasts").textContent, /fixture failure/);
});


for (const operation of ["install", "uninstall"]) {
  test(operation + " still preserves unsaved external rows and empty-list semantics", async () => {
    const h = harness({
      installSkill: () => ({ result: { id: "installed-new" }, catalog: catalog({ installed: [skill("installed-new")] }) }),
      uninstallSkill: () => ({ catalog: catalog({ installed: [] }) }),
    });
    await h.run("loadSkillCatalog()");
    for (const row of rows(h)) await row.querySelector("button").fire("click");
    if (operation === "install") {
      await addRegistration(h, "keep-new-row");
      h.run('state.install = { source: "D:/fixture/source" }');
      h.node("f-install-id").value = "installed-new";
    }
    const before = h.registrations();
    const beforeRows = rows(h);
    if (operation === "install") await h.node("btn-install-confirm").fire("click");
    else await h.node("installed-skills-list").querySelector("button").fire("click");
    assert.deepEqual(h.registrations(), before);
    assert.equal(rows(h).length, beforeRows.length);
    for (let index = 0; index < beforeRows.length; index++) assert.equal(rows(h)[index], beforeRows[index]);
    if (operation === "install") {
      assert.match(h.node("installed-skills-list").textContent, /installed-new/);
      assert.equal(h.node("install-skill-panel").hidden, true);
    } else {
      assert.match(h.node("installed-skills-list").textContent, /未发现/);
      assert.match(h.node("registered-skills-list").textContent, /清空/);
    }
  });
}

test("raw whitespace edits during refresh are not mistaken for an unchanged save payload", async () => {
  const pending = deferred();
  const h = harness();
  await h.run("loadSkillCatalog()");
  h.methods.getSkillCatalog = () => pending.promise;
  const refresh = h.run("loadSkillCatalog()");
  const row = rows(h)[0];
  nameInput(row).value += " ";
  pending.resolve(catalog());
  await refresh;
  assert.equal(rows(h)[0], row);
  assert.equal(nameInput(row).value, "external-one ");
});

test("a rejected refresh leaves the current draft in place and reports the error", async () => {
  const h = harness();
  await h.run("loadSkillCatalog()");
  const row = rows(h)[0];
  nameInput(row).value = "keep-after-error";
  h.methods.getSkillCatalog = () => { throw new Error("fixture read failure"); };
  await h.node("btn-skills-refresh").fire("click");
  await settle();
  assert.equal(rows(h)[0], row);
  assert.equal(nameInput(row).value, "keep-after-error");
  assert.match(h.node("toasts").textContent, /fixture read failure/);
});

for (const setupDone of [true, false]) {
  test("window/header identity uses app info across views (setupDone=" + setupDone + ")", async () => {
    const info = { name: "ChatGPT Web Harness Isolated", version: "0.1.4-isolated.1", encryptionAvailable: true, isPackaged: false };
    const config = { setupDone, mcpPort: 3000, adminPort: 3001, tunnelPort: 8080 };
    const h = harness({
      appInfo: () => info, getConfig: () => config,
      getLogs: () => ({ mcp: ["startup fixture"], tunnel: [], launcher: [] }),
      getStatus: () => ({ at: 0, busy: false, config, mcp: {}, tunnel: {}, paths: { codeRoot: "fixture-code", runtimeDir: "fixture-runtime" } }),
    }, { bind: false });
    await h.run("init()");
    const identity = info.name + " · v" + info.version;
    assert.equal(h.document.title, identity);
    assert.ok(h.node("page-subtitle").textContent.startsWith(identity));
    assert.equal(h.run("state.view"), setupDone ? "dashboard" : "settings");
    for (const view of ["skills", "settings", "dashboard"]) {
      h.context.nextView = view;
      h.run("showView(nextView)");
      await settle();
      assert.ok(h.node("page-subtitle").textContent.startsWith(identity));
      assert.equal(h.document.title, identity);
    }
    assert.equal(h.node("log-view").textContent, "startup fixture\n");
    assert.equal(h.node("toasts").textContent.trim(), "", "no visible error toast should be present");
  });
}

test("identity is retained even if configuration initialization fails", async () => {
  const h = harness({
    appInfo: () => ({ name: "Another Isolated Fixture", version: "9.8.7-fixture" }),
    getConfig: () => { throw new Error("fixture configuration error"); },
  }, { bind: false });
  await h.run("init()");
  assert.equal(h.document.title, "Another Isolated Fixture · v9.8.7-fixture");
  assert.match(h.node("page-subtitle").textContent, /Another Isolated Fixture.*9\.8\.7-fixture/);
  assert.match(h.node("toasts").textContent, /fixture configuration error/);
});


test("catch-up appends only the hidden tail and retains surviving log nodes", (t) => {
  const h = harness();
  h.run('renderLog("mcp")');
  logBatch(h, "mcp", 3000);
  const survivor = h.node("log-view").childNodes[100];
  h.node("log-autoscroll").checked = false;
  h.node("log-view").scrollTop = 120;
  h.run('showView("settings")');
  h.resetMetrics();
  for (let batch = 0; batch < 10; batch++) logBatch(h, "mcp", 10, 3000 + batch * 10);
  assert.equal(h.metrics.created, 0);
  h.run('showView("dashboard")');
  t.diagnostic("3000 retained / 100 hidden lines, catch-up: created=" + h.metrics.created + ", clears=" + h.metrics.logClears);
  assert.equal(h.metrics.created, 100);
  assert.equal(h.metrics.logClears, 0);
  assert.equal(h.node("log-view").firstChild, survivor);
  assert.equal(h.node("log-view").childNodes.length, 3000);
  assert.equal(h.node("log-view").childNodes.at(-1).textContent, "mcp line 3099\n");
  assert.equal(h.node("log-view").scrollTop, 120);
});


test("legacy import hides its entire row when no keys are available", () => {
  const h = harness();
  const row = h.node("legacy-import-row");
  const buttons = h.node("legacy-import-buttons");
  assert.ok(row.contains(buttons));
  assert.match(row.textContent, /从旧脚本保存的加密密钥导入/);
  for (const info of [{ legacyKeys: [] }, { legacyKeys: ["fixture-key"] }, { legacyKeys: [] }, {}]) {
    h.context.fixtureInfo = info;
    h.run("state.info = fixtureInfo; fillSetupForm()");
    const hasKeys = Boolean(info.legacyKeys?.length);
    assert.equal(row.hidden, !hasKeys);
    assert.equal(buttons.querySelectorAll("button").length, hasKeys ? 1 : 0);
    if (hasKeys) assert.match(buttons.textContent, /导入 fixture-key 密钥/);
  }
  assert.equal(h.calls.length, 0, "Showing or hiding the row must not invoke legacy import IPC");
  // The DOM harness has no layout engine. The property was already true in this
  // regression: verify the scoped author rule that defeats .row's display:flex too.
  const styles = fs.readFileSync(path.join(__dirname, "../renderer/styles.css"), "utf8");
  const hiddenRule = styles.match(/#legacy-import-row\[hidden\]\s*\{([^}]*)\}/);
  assert.ok(hiddenRule, "The entire legacy import row needs an author-level hidden rule");
  assert.match(hiddenRule[1], /(?:^|;)\s*display\s*:\s*none\s*(?:!important\s*)?(?:;|$)/);
});


test("save invalidates an older refresh before its response can repaint the submitted draft", async (t) => {
  const read = deferred(), write = deferred();
  const h = harness({ saveSkillCatalog: () => write.promise });
  await h.run("loadSkillCatalog()");
  nameInput(rows(h)[0]).value = "submitted-name";
  h.methods.getSkillCatalog = () => read.promise;
  const refresh = h.run("loadSkillCatalog()");
  const save = h.node("btn-skills-save").fire("click");
  assert.equal(h.calls.at(-1).payload.registrations[0].id, "submitted-name");
  read.resolve(catalog());
  await refresh;
  const duringSave = nameInput(rows(h)[0]).value;
  write.resolve({ catalog: catalog({ external: [skill("submitted-name", { path: skill("external-one").path }), skill("external-two")] }) });
  await save;
  t.diagnostic("old read then save response: duringSave=" + duringSave + ", state=" + h.run("state.skills.external[0].id") + ", DOM=" + nameInput(rows(h)[0]).value);
  assert.equal(h.run("state.skills.external[0].id"), "submitted-name");
  assert.equal(nameInput(rows(h)[0]).value, "submitted-name");
  assert.equal(duringSave, "submitted-name");
  assert.doesNotMatch(h.node("toasts").textContent, /后续编辑尚未保存/);
  assert.equal(h.node("btn-skills-save").disabled, false);
});

test("refresh requests stay blocked while saving without discarding real user edits", async () => {
  const write = deferred();
  const h = harness({ saveSkillCatalog: () => write.promise });
  await h.run("loadSkillCatalog()");
  nameInput(rows(h)[0]).value = "submitted-name";
  const readsBefore = h.calls.filter((call) => call.name === "getSkillCatalog").length;
  const save = h.node("btn-skills-save").fire("click");
  const row = rows(h)[0];
  nameInput(row).value = "newer-user-edit";
  enabledInput(row).checked = false;
  const draft = h.registrations();
  await h.node("btn-skills-refresh").fire("click");
  await settle();
  const readsDuringSave = h.calls.filter((call) => call.name === "getSkillCatalog").length;
  write.resolve({ catalog: catalog({ external: [skill("submitted-name", { path: skill("external-one").path }), skill("external-two")] }) });
  await save;
  assert.equal(readsDuringSave, readsBefore, "No getSkillCatalog IPC should be sent during a save");
  assert.deepEqual(h.registrations(), draft);
  assert.equal(rows(h)[0], row);
  assert.match(h.node("toasts").textContent, /后续编辑尚未保存/);
  await h.run("loadSkillCatalog()");
  assert.equal(h.calls.filter((call) => call.name === "getSkillCatalog").length, readsBefore + 1, "Reads resume after save completion");
});

test("isolated renderer always disables external takeover even for recognized processes", () => {
  const h = harness();
  h.context.snapshot = {
    at: 0, busy: false, config: { setupDone: true },
    mcp: { external: true, externalRecognized: true },
    tunnel: { external: true, externalRecognized: true },
    paths: { codeRoot: "fixture-code", runtimeDir: "fixture-runtime" },
  };
  h.run("state.info = { isolated: false }; renderStatus(snapshot)");
  assert.equal(h.node("btn-stop-external").disabled, false, "Non-isolated takeover eligibility is unchanged");
  h.run("state.info = { isolated: true }; renderStatus(snapshot)");
  assert.equal(h.node("btn-stop-external").disabled, true);
  assert.equal(h.calls.length, 0, "Status rendering never invokes process-control IPC");
});

test("account-scoped IPC carries the originating account and rejects a late response after selection changes", async () => {
  const pending = deferred();
  const h = harness({ getConfig: () => pending.promise });
  h.run('state.accountId = "default"');
  const request = h.run('call("getConfig")');
  assert.deepEqual(h.calls.at(-1), { name: "getConfig", payload: { _accountId: "default" } });
  h.run('state.accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
  pending.resolve({ setupDone: true });
  await assert.rejects(request, (error) => error && error.code === "STALE_ACCOUNT_RESPONSE");
});

test("renderer ignores status-adjacent events from another account", () => {
  const h = harness();
  h.run('state.accountId = "default"; state.logs = { mcp: [], tunnel: [], launcher: [] }; renderLog("mcp")');
  h.emit("log", [{ accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "mcp", line: "foreign" }]);
  assert.equal(h.run("state.logs.mcp.length"), 0);
  h.emit("log", [{ accountId: "default", name: "mcp", line: "own" }]);
  assert.deepEqual(json(h.run("state.logs.mcp")), ["own"]);
  h.emit("notice", { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", level: "error", message: "foreign notice" });
  assert.doesNotMatch(h.node("toasts").textContent, /foreign notice/);
  h.emit("notice", { accountId: "default", level: "info", message: "own notice" });
  assert.match(h.node("toasts").textContent, /own notice/);
  const before = h.node("setup-progress-title").textContent;
  h.emit("setup:progress", { accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", stage: "message", message: "foreign setup" });
  assert.equal(h.node("setup-progress-title").textContent, before);
  h.emit("setup:progress", { accountId: "default", stage: "message", message: "own setup" });
  assert.equal(h.node("setup-progress-title").textContent, "own setup");
});

test("switching profiles reloads only the selected account and never stops the previous account", async () => {
  const secondId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const defaultConfig = { setupDone: true, mcpPort: 3000, adminPort: 3001, tunnelPort: 8080, workspacePath: "D:/fixture/a" };
  const secondConfig = { setupDone: true, mcpPort: 3400, adminPort: 3401, tunnelPort: 3402, workspacePath: "D:/fixture/b" };
  const row = (id, name, config, owned = false) => ({
    id, name, dataDir: `D:/fixture/${id}`, config,
    mcp: { state: owned ? "running" : "stopped", pid: owned ? 101 : null, owned },
    tunnel: { state: owned ? "running" : "stopped", pid: owned ? 102 : null, owned, cloudState: owned ? "online" : "unknown" },
    busy: false, lastError: "",
  });
  const firstSnapshot = { selectedId: "default", maxAccounts: 16, securityBoundary: "fixture", accounts: [row("default", "主账号", defaultConfig, true), row(secondId, "第二账号", secondConfig)] };
  const secondSnapshot = { ...firstSnapshot, selectedId: secondId };
  const h = harness({
    selectAccount: ({ id }) => { assert.equal(id, secondId); return secondSnapshot; },
    appInfo: () => ({ name: "Harness", version: "1", encryptionAvailable: true, isPackaged: true, multiAccount: true }),
    getConfig: () => secondConfig,
    getLogs: () => ({ mcp: ["second log"], tunnel: [], launcher: [] }),
    getStatus: () => ({
      accountId: secondId, at: 0, busy: false, config: secondConfig,
      mcp: { managed: false, state: "stopped", healthy: false },
      tunnel: { managed: false, state: "stopped", ready: false, reachable: false, cloudState: "unknown" },
      paths: { codeRoot: "fixture-code", runtimeDir: "D:/fixture/b/runtime" },
    }),
  });
  h.context.firstSnapshot = firstSnapshot;
  h.run('state.accountId = "default"; state.accounts = firstSnapshot; renderAccounts()');
  await h.run(`switchAccount("${secondId}")`);
  assert.equal(h.run("state.accountId"), secondId);
  assert.equal(h.node("dashboard-account-name").textContent, "第二账号");
  assert.equal(h.node("dashboard-account-endpoints").textContent, "MCP 3400 · Admin 3401 · Tunnel 3402");
  assert.equal(h.node("log-view").textContent, "second log\n");
  assert.ok(h.calls.every((call) => !["stopAll", "stopMcp", "stopTunnel", "stopExternal"].includes(call.name)), "Profile switching must not stop another profile's services");
});
