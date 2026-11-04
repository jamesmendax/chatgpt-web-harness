import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EffectiveToolRegistry } from "../dist/lib/effective-tool-registry.js";
import { InvocationGateway } from "../dist/lib/invocation-gateway.js";
import { compileExecutionContract } from "../dist/lib/execution-contract.js";
import { parseRequirementModel } from "../dist/lib/requirement-readiness.js";
import { writeTextFileCas } from "../dist/lib/safe-text-write.js";
import { createRuntimeScope, runWithRuntimeScope } from "../dist/lib/runtime-scope.js";
import { assertRecoveryIngress, assertRecoveryWriteCommit, signRecoveryWriteGrant, signRecoveryOperatorAttestation } from "../dist/lib/recovery-integrity.js";
import { createMcpServer, getMcpServerHarnessRuntime } from "../dist/server-factory.js";
import { inspectOperation } from "../dist/lib/operation-journal.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const root = await mkdtemp(path.join(os.tmpdir(), "ri-gateway-"));
const envKeys = ["CODEX_HOME", "HARNESS_RECOVERY_SCOPE_MODE", "HARNESS_RECOVERY_ISOLATED",
  "HARNESS_RECOVERY_GRANT_FILE", "HARNESS_RECOVERY_HMAC_KEY", "HARNESS_RECOVERY_HEAD_PATH",
  "HARNESS_RECOVERY_ATTESTATION_FILE"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const readyIntent = JSON.stringify({
  intent_revision: 1, objective: "Execute an isolated Recovery Integrity test",
  scope: ["isolated fixture"], out_of_scope: [], deliverables: ["test result"],
  success_criteria: ["expected operation is admitted or denied"],
  constraints: [], protected_resources: [], known_facts: ["isolated fixture"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});
const contractHash = compileExecutionContract(parseRequirementModel(readyIntent)).requirement_hash;
const key = randomBytes(32);
const checks = [];
try {
  const workspace = path.join(root, "workspace");
  const headPath = path.join(root, "current-head.json");
  const grantFile = path.join(root, "operator-grant.json");
  const attestationFile = path.join(root, "operator-attestation.json");
  const originalHead = JSON.stringify({ schema_version: 2, snapshot_revision: 2, project_phase: "review_pending" });
  await mkdir(workspace, { recursive: true });
  await writeFile(headPath, originalHead, "utf8");
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.HARNESS_RECOVERY_SCOPE_MODE = "scoped_write_v1";
  process.env.HARNESS_RECOVERY_ISOLATED = "1";
  process.env.HARNESS_RECOVERY_GRANT_FILE = grantFile;
  process.env.HARNESS_RECOVERY_ATTESTATION_FILE = attestationFile;
  process.env.HARNESS_RECOVERY_HMAC_KEY = key.toString("base64url");
  process.env.HARNESS_RECOVERY_HEAD_PATH = headPath;

  const sessionId = "ri-trusted-session";
  const target = path.join(workspace, "allowed.txt");
  const payload = "safe-v1";
  const grantBase = {
    version: 1, operation_id: "fixture-write-00001", operator_ref: "operator-fixture",
    workspace_root: workspace, session_id: sessionId,
    head_sha256: sha(originalHead), snapshot_revision: 2,
    intent_revision: 1, contract_hash: contractHash,
    target_path: target, content_sha256: sha(payload),
    expected_sha256: null, create_only: true,
    issued_at: new Date(Date.now() - 10_000).toISOString(),
    expires_at: new Date(Date.now() + 120_000).toISOString(),
  };
  const putGrant = async (overrides = {}, withAttestation = true) => {
    const grant = { ...grantBase, ...overrides };
    await writeFile(grantFile, JSON.stringify(signRecoveryWriteGrant(grant, key)), "utf8");
    if (withAttestation) {
      const attestation = {
        version: 1, source_kind: "operator_attested",
        evidence_ref: "operator-fixture-receipt-001", operator_ref: grant.operator_ref,
        grant_sha256: sha(JSON.stringify(grant)), decision: "approved",
        approved_at: new Date(Date.now() - 12_000).toISOString(),
      };
      await writeFile(attestationFile, JSON.stringify(signRecoveryOperatorAttestation(attestation, key)), "utf8");
    } else {
      await rm(attestationFile, { force: true });
    }
    return grant;
  };
  const registry = new EffectiveToolRegistry("full");
  let callbacks = 0, shellCalls = 0, upstreamCalls = 0, reads = 0;
  registry.register("write_file", {
    inputSchema: { path: {}, content: {}, create_only: {}, expected_sha256: {} },
    annotations: { readOnlyHint: false },
  }, async ({ path: file, content, create_only, expected_sha256 }) => {
    callbacks++;
    const result = await writeTextFileCas(file, content, {
      createOnly: create_only, expectedSha256: expected_sha256,
      beforeCommit: () => assertRecoveryWriteCommit({ path: file, content, create_only, expected_sha256 }),
    });
    return { content: [{ type: "text", text: "written" }], structuredContent: result };
  });
  registry.register("read_text_file", { inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => { reads++; return { content: [{ type: "text", text: "read" }] }; });
  registry.register("run_command", { inputSchema: {}, annotations: { readOnlyHint: false } },
    async () => { shellCalls++; return { content: [{ type: "text", text: "shell" }] }; });
  registry.register("fake__read_text_file", { inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => { upstreamCalls++; return { content: [{ type: "text", text: "upstream" }] }; });
  const gateway = new InvocationGateway(registry, {
    workspaceRoot: workspace, projectRoots: [workspace], fallbackSessionId: sessionId,
  });
  const invokeWrite = (file, content, cas = { create_only: true }) =>
    gateway.invoke("write_file", { path: file, content, ...cas, _intent: readyIntent });
  const blocked = async (tool, args) => {
    const reply = await gateway.invoke(tool, args);
    assert.equal(reply.isError, true, `${tool} must be explicitly rejected`);
    assert.match(JSON.stringify(reply), /RI_BLOCKED|RI_RECONCILE_REQUIRED/);
  };

  // Missing trusted key/file fails closed despite a high-RRS _intent.
  await blocked("write_file", { path: target, content: payload, create_only: true, _intent: readyIntent });
  assert.equal(callbacks, 0);
  await assert.rejects(() => readFile(target), { code: "ENOENT" });
  checks.push("missing grant denied");

  // An HMAC grant plus arbitrary operator_ref is insufficient source proof:
  // require a *second* operator-controlled, signed, action-bound attestation.
  await putGrant({}, false);
  await blocked("write_file", { path: target, content: payload, create_only: true, _intent: readyIntent });
  assert.equal(callbacks, 0);
  checks.push("missing independently stored operator attestation denied");

  const authGrant = await putGrant();
  const attestationBase = {
    version: 1, source_kind: "operator_attested",
    evidence_ref: "operator-fixture-receipt-001",
    operator_ref: authGrant.operator_ref,
    grant_sha256: sha(JSON.stringify(authGrant)),
    decision: "approved", approved_at: new Date(Date.now() - 5_000).toISOString(),
  };
  const pretendHost = { ...attestationBase, source_kind: "host_verified" };
  await writeFile(attestationFile, JSON.stringify(signRecoveryOperatorAttestation(pretendHost, key)));
  await blocked("write_file", { path: target, content: payload, create_only: true, _intent: readyIntent });
  const tamperedEvidence = signRecoveryOperatorAttestation(attestationBase, key);
  tamperedEvidence.attestation = { ...attestationBase, evidence_ref: "forged-source-ref" };
  await writeFile(attestationFile, JSON.stringify(tamperedEvidence));
  await blocked("write_file", { path: target, content: payload, create_only: true, _intent: readyIntent });
  await putGrant();
  assert.equal(callbacks, 0);
  checks.push("claimed Host origin and tampered operator evidence denied");

  // Tool name tricks, an upstream alias, and shell are not permitted.
  await blocked("run_command", { command: "echo bypass", _intent: readyIntent });
  await blocked("fake__read_text_file", {});
  assert.equal(shellCalls, 0);
  assert.equal(upstreamCalls, 0);
  const read = await gateway.invoke("read_text_file", {});
  assert.equal(read.isError, undefined);
  assert.equal(reads, 1);
  checks.push("shell/upstream refused and native read allowed");

  // Signature controls one exact target and payload, not a Markdown READY claim.
  await putGrant();
  await blocked("write_file", { path: path.join(workspace, "other.txt"), content: payload, create_only: true, _intent: readyIntent });
  await blocked("write_file", { path: target, content: "injected", create_only: true, _intent: readyIntent });
  await blocked("write_file", { path: target, content: payload, _intent: readyIntent });
  assert.equal(callbacks, 0);
  checks.push("target/content/unconditional-write mismatch denied");

  // The user's workspace is a logical boundary, not just a string prefix.
  // Windows directory junctions and POSIX symlinks must not redirect a
  // signed in-workspace path to an outside file.
  const external = path.join(root, "external");
  const junction = path.join(workspace, "redirect");
  await mkdir(external, { recursive: true });
  await symlink(external, junction, process.platform === "win32" ? "junction" : "dir");
  const lexicalTarget = path.join(junction, "should-not-exist.txt");
  const physicalTarget = path.join(external, "should-not-exist.txt");
  await putGrant({
    operation_id: "fixture-write-symlink", target_path: lexicalTarget,
    content_sha256: sha("symlink-bypass"),
  });
  await blocked("write_file", {
    path: lexicalTarget, content: "symlink-bypass", create_only: true, _intent: readyIntent,
  });
  await assert.rejects(() => readFile(physicalTarget), { code: "ENOENT" });
  assert.equal(callbacks, 0);
  checks.push("symlink/junction escape denied");

  const tampered = signRecoveryWriteGrant(grantBase, key);
  tampered.grant = { ...grantBase, content_sha256: sha("forged") };
  await writeFile(grantFile, JSON.stringify(tampered));
  await blocked("write_file", { path: target, content: payload, create_only: true, _intent: readyIntent });
  await putGrant({ issued_at: new Date(Date.now() - 240_000).toISOString(), expires_at: new Date(Date.now() - 120_000).toISOString() });
  await blocked("write_file", { path: target, content: payload, create_only: true, _intent: readyIntent });
  await putGrant();
  await writeFile(headPath, JSON.stringify({ schema_version: 2, snapshot_revision: 3 }));
  await blocked("write_file", { path: target, content: payload, create_only: true, _intent: readyIntent });
  await writeFile(headPath, originalHead);
  assert.equal(callbacks, 0);
  checks.push("forged/expired/stale-head denied");

  // Real safe-text writer: exact signed create_only operation succeeds once.
  await putGrant();
  const first = await invokeWrite(target, payload);
  assert.equal(first.isError, undefined, JSON.stringify(first));
  assert.equal(await readFile(target, "utf8"), payload);
  assert.equal(callbacks, 1);
  await blocked("write_file", { path: target, content: payload, create_only: true, _intent: readyIntent });
  assert.equal(await readFile(target, "utf8"), payload);
  checks.push("signed create_only success, replay conflict");

  // Exact signed compare-and-swap replacement and stale baseline rejection.
  const next = "safe-v2";
  const expected = sha(payload);
  await putGrant({ operation_id: "fixture-write-00002", create_only: false, expected_sha256: expected, content_sha256: sha(next) });
  const second = await invokeWrite(target, next, { expected_sha256: expected });
  assert.equal(second.isError, undefined, JSON.stringify(second));
  assert.equal(await readFile(target, "utf8"), next);
  await blocked("write_file", { path: target, content: next, expected_sha256: expected, _intent: readyIntent });
  checks.push("signed CAS replacement, replay conflict");

  // CAS alone is not a durable replay barrier: an unrelated writer may restore
  // the exact prior bytes after the first authorized effect. The original
  // operation_id must not execute again, even when the content hash matches.
  await writeFile(target, payload, "utf8");
  await blocked("write_file", { path: target, content: next, expected_sha256: expected, _intent: readyIntent });
  assert.equal(await readFile(target, "utf8"), payload);
  checks.push("durable consumed operation survives external rollback");

  // A fresh process must consult the same on-disk completed receipt, not
  // mistake a restored old CAS baseline for a never-issued operation.
  const completedProbe = spawnSync(process.execPath, [path.resolve("scripts/test-recovery-crash-child.mjs")], {
    env: {
      ...process.env, RI_TEST_PROBE_ONLY: "1", RI_TEST_WORKSPACE: workspace,
      RI_TEST_SESSION: sessionId, RI_TEST_TARGET: target,
      RI_TEST_CONTENT: next, RI_TEST_EXPECTED_SHA256: expected,
    },
    timeout: 8_000, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  assert.equal(completedProbe.status, 0,
    `a fresh process must block an already committed ID: ${completedProbe.stderr}`);
  assert.match(completedProbe.stdout, /RI_RECONCILE_REQUIRED/);
  assert.equal(await readFile(target, "utf8"), payload);
  checks.push("completed operation remains consumed after process restart and external rollback");

  // Concurrent independent RPCs with the same signed operation ID must share
  // one durable journal identity, not dispatch two callbacks.
  const parallelTarget = path.join(workspace, "parallel-once.txt");
  const parallelContent = "exactly-one-callback";
  await putGrant({
    operation_id: "fixture-parallel-once", target_path: parallelTarget,
    content_sha256: sha(parallelContent), expected_sha256: null, create_only: true,
  });
  const beforeParallel = callbacks;
  const outcomes = await Promise.all([
    invokeWrite(parallelTarget, parallelContent),
    invokeWrite(parallelTarget, parallelContent),
  ]);
  assert.ok(outcomes.some((reply) => reply.isError !== true), "one concurrent caller must succeed");
  assert.equal(callbacks, beforeParallel + 1, "concurrent calls dispatched the same effect twice");
  assert.equal(await readFile(parallelTarget, "utf8"), parallelContent);
  checks.push("concurrent signed operation shares one durable execution");

  // A signed grant revoked after entering the file lock must still block
  // publication: this runs the real CAS writer and its pre-commit hook.
  const pending = path.join(workspace, "revoked-during-write.txt");
  const input = { path: pending, content: "never-published", create_only: true };
  await putGrant({
    operation_id: "fixture-write-00003", target_path: pending,
    content_sha256: sha(input.content), expected_sha256: null, create_only: true,
  });
  const scope = createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace], fallbackSessionId: sessionId });
  await runWithRuntimeScope(scope, async () => {
    await assertRecoveryIngress("write_file", "native", input, scope);
    await assertRecoveryWriteCommit(input);
    await assert.rejects(() => writeTextFileCas(pending, input.content, {
      createOnly: true,
      beforePublish: async () => {
        const invalid = signRecoveryWriteGrant({ ...grantBase, target_path: pending, content_sha256: sha(input.content) }, key);
        invalid.hmac_sha256 = "0".repeat(64);
        await writeFile(grantFile, JSON.stringify(invalid), "utf8");
      },
      beforeCommit: () => assertRecoveryWriteCommit(input),
    }), /RI_BLOCKED/);
  });
  await assert.rejects(() => readFile(pending), { code: "ENOENT" });
  checks.push("revocation before commit blocks publication");

  // A call admitted into strict mode must not silently become unguarded if
  // process-side configuration changes before its final commit.
  const modeTarget = path.join(workspace, "mode-revoked.txt");
  const modeInput = { path: modeTarget, content: "not-published", create_only: true };
  await putGrant({
    operation_id: "fixture-mode-revoke", target_path: modeTarget,
    content_sha256: sha(modeInput.content), create_only: true, expected_sha256: null,
  });
  const modeScope = createRuntimeScope({
    workspaceRoot: workspace, projectRoots: [workspace], fallbackSessionId: sessionId,
  });
  await runWithRuntimeScope(modeScope, async () => {
    await assertRecoveryIngress("write_file", "native", modeInput, modeScope);
    process.env.HARNESS_RECOVERY_SCOPE_MODE = "off";
    try {
      await assert.rejects(() => assertRecoveryWriteCommit(modeInput), /RI_BLOCKED/);
    } finally {
      process.env.HARNESS_RECOVERY_SCOPE_MODE = "scoped_write_v1";
    }
  });
  await assert.rejects(() => readFile(modeTarget), { code: "ENOENT" });
  checks.push("in-flight mode downgrade cannot bypass commit recheck");

  // Run the production MCP server registration, actual write_file callback,
  // its checkpoint hook, CAS writer and the new pre-commit revalidation.
  // This tests the real composition, not just the isolated registry callback.
  const server = createMcpServer(workspace, 30_000, [workspace], false);
  try {
    const runtime = getMcpServerHarnessRuntime(server);
    assert.ok(runtime?.registry.get("write_file"), "production write_file registration missing");
    const allowedStrictTools = new Set([
      "read_text_file", "read_file_base64", "file_info", "list_directory",
      "glob", "grep", "search_files", "project_context", "load_path_rules", "write_file",
    ]);
    const exposed = runtime.registry.list().map((tool) => tool.name);
    assert.ok(exposed.length > 0 && exposed.every((name) => allowedStrictTools.has(name)),
      `strict registry exposed unguarded tools: ${exposed.filter((name) => !allowedStrictTools.has(name)).join(", ")}`);
    checks.push("strict MCP catalog exposes no effectful alternate tools");
    const realTarget = path.join(workspace, "real-registered-handler.txt");
    const realContent = "real-handler-fixture";
    await putGrant({
      operation_id: "fixture-real-handler", target_path: realTarget,
      content_sha256: sha(realContent), expected_sha256: null, create_only: true,
    });
    const result = await runtime.gateway.invoke("write_file", [
      { path: realTarget, content: realContent, create_only: true, _intent: readyIntent },
      { sessionId, requestId: 888, signal: new AbortController().signal },
    ]);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result));
    assert.equal(await readFile(realTarget, "utf8"), realContent);
    checks.push("real registered MCP write_file handler uses strict admission and commit hook");
  } finally {
    await server.close();
  }
  assert.throws(
    () => createMcpServer(workspace, 30_000, [workspace], true),
    /RI_ISOLATED_BOUNDARY_REQUIRED/,
    "full disk access must not be possible in a strict isolated MCP server",
  );
  checks.push("strict MCP server refuses full-disk access");

  // The ordinary full-runtime entry must not expose the unfinished Admin /
  // Companion / background effects while an isolated-MCP RI preview is active.
  // This subprocess is expected to exit *before* opening network listeners.
  const boot = spawnSync(process.execPath, [path.resolve("dist/index.js")], {
    env: { ...process.env, WORKSPACE_PATH: workspace, HOST: "127.0.0.1", PORT: "0", ADMIN_PORT: "0" },
    timeout: 8_000, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  assert.equal(boot.status, 1, `unsafe full-runtime startup not rejected: ${boot.stderr}`);
  assert.equal(boot.signal, null, "startup must fail without waiting for a timeout");
  assert.match(boot.stderr, /RI_PARTIAL_PROFILE_NOT_SHARED/);
  checks.push("full-runtime startup refuses the partial RI preview");

  // Cross-process crash between durable journal admission and file publish:
  // the executing receipt must survive abrupt process exit and fence both
  // same-operation retries and new operation IDs until reconciliation.
  const crashTarget = path.join(workspace, "crash-window.txt");
  const crashContent = "not-published-before-crash";
  const crashInput = { path: crashTarget, content: crashContent, create_only: true };
  await putGrant({
    operation_id: "fixture-crash-executing", target_path: crashTarget,
    content_sha256: sha(crashContent), expected_sha256: null, create_only: true,
  });
  const crashScope = createRuntimeScope({
    workspaceRoot: workspace, projectRoots: [workspace], fallbackSessionId: sessionId,
  });
  const crashPermit = await runWithRuntimeScope(crashScope, () =>
    assertRecoveryIngress("write_file", "native", crashInput, crashScope)
  );
  assert.ok(crashPermit?.identity);
  const crash = spawnSync(process.execPath, [path.resolve("scripts/test-recovery-crash-child.mjs")], {
    env: { ...process.env, RI_TEST_WORKSPACE: workspace, RI_TEST_SESSION: sessionId,
      RI_TEST_TARGET: crashTarget, RI_TEST_CONTENT: crashContent },
    timeout: 8_000, encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  assert.equal(crash.status, 73, `crash fixture failed before executing claim: ${crash.stderr}`);
  const originalReceipt = await inspectOperation(workspace, crashPermit.identity);
  assert.equal(originalReceipt?.state, "executing", "crash must preserve durable executing receipt");
  await blocked("write_file", { ...crashInput, _intent: readyIntent });
  await putGrant({
    operation_id: "fixture-crash-new-op", target_path: crashTarget,
    content_sha256: sha(crashContent), expected_sha256: null, create_only: true,
  });
  await blocked("write_file", { ...crashInput, _intent: readyIntent });
  await assert.rejects(() => readFile(crashTarget), { code: "ENOENT" });
  checks.push("cross-process crash receipt survives and fences same/new operation IDs");

  console.log(`Recovery Integrity focused PASS: ${checks.length} groups`);
  for (const check of checks) console.log(`  PASS ${check}`);
} finally {
  for (const [keyName, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[keyName];
    else process.env[keyName] = value;
  }
  await rm(root, { recursive: true, force: true });
}
