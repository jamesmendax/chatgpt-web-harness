import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import nodeFs from "node:fs";
import { Writable } from "node:stream";
import { z } from "zod";
import { EffectiveToolRegistry } from "../src/lib/effective-tool-registry.ts";
import { InvocationGateway } from "../src/lib/invocation-gateway.ts";
import { registerShellTools } from "../src/tools/shell.ts";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wh-result-phases-")), oldHome = process.env.CODEX_HOME;
try {
  process.env.CODEX_HOME = path.join(temp, "state");
  const registry = new EffectiveToolRegistry("full"), traces = []; let effect = 0, failureHook = 0;
  registry.register(registry.prepare("fixture_read", { inputSchema: {}, annotations: { readOnlyHint:true } }, async () => { effect++; return { content:[{type:"text",text:"handler result"}] }; }));
  const gateway = new InvocationGateway(registry, {workspaceRoot:temp,projectRoots:[temp]}, { onSuccess: () => { throw Error("postprocess fault"); }, onFailure: () => { failureHook++; }, trace: x => traces.push(x) });
  const result = await gateway.invoke("fixture_read", [{}]);
  assert.equal(effect, 1); assert.equal(failureHook, 0); assert.equal(result.isError, true);
  assert.equal(result.structuredContent.data.error, "RESULT_POSTPROCESSING_FAILED");
  assert.equal(result.structuredContent.data.handler_returned, true);
  assert.equal(result.structuredContent.data.reconciliation_needed, true);
  assert.equal(result.structuredContent.data.retryable, false);
  assert.match(result.structuredContent.data.next_action, /do not blindly repeat/i);
  const trace = traces.at(-1); assert.equal(trace.handlerEntered, true); assert.equal(trace.handlerReturned, true); assert.equal(trace.postprocessingCompleted, false);
  const handlers = new Map();
  // Match the MCP registration boundary: schema defaults (including UTF-8) are
  // applied before a handler is called, while the injected log failure stays real.
  registerShellTools({ registerTool(name, schema, handler) {
    handlers.set(name, args => handler(z.object(schema.inputSchema).parse(args)));
  } }, temp, 5);
  const originalCreateWriteStream = nodeFs.createWriteStream;
  try {
    nodeFs.createWriteStream = () => new Writable({ write(_chunk, _enc, callback) {
      setImmediate(() => callback(Object.assign(new Error("disk full"), {code:"ENOSPC"})));
    } });
    for (const mode of ["compact", "full", "none"]) {
      const shell = await handlers.get("run_command")({ command: process.platform === "win32" ? "Write-Output shell-ok" : "echo shell-ok", output_mode:mode, output_chars:12000 });
      assert.equal(shell.structuredContent.data.exit_code, 0, JSON.stringify(shell.structuredContent));
      assert.equal(shell.structuredContent.data.log_incomplete, true, mode);
      assert.equal(shell.structuredContent.data.log_error, "ENOSPC", mode);
    }
  } finally { nodeFs.createWriteStream = originalCreateWriteStream; }
  console.log("PASS postprocessing failure distinguishes completed handler and prohibits blind retry");
} finally { if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; await fs.rm(temp, {recursive:true,force:true}); }
