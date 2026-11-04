/** Isolated crash-window and cold-process replay fixtures. The real
 * Operation Journal must persist its executing receipt before the callback
 * exits, and a later process must reject an already completed identity.
 * This test must never be used against a non-fixture workspace.
 */
import { createRuntimeScope, runWithRuntimeScope } from "../dist/lib/runtime-scope.js";
import { assertRecoveryIngress, assertRecoveryWriteCommit } from "../dist/lib/recovery-integrity.js";
import { executeOperation } from "../dist/lib/operation-journal.js";

const workspace = process.env.RI_TEST_WORKSPACE;
const sessionId = process.env.RI_TEST_SESSION;
const target = process.env.RI_TEST_TARGET;
const content = process.env.RI_TEST_CONTENT;
if (!workspace || !sessionId || !target || !content || !target.startsWith(workspace)) {
  throw new Error("RI_TEST_CHILD_MISSING_FIXTURE_SCOPE");
}
const input = process.env.RI_TEST_EXPECTED_SHA256
  ? { path: target, content, expected_sha256: process.env.RI_TEST_EXPECTED_SHA256 }
  : { path: target, content, create_only: true };
const scope = createRuntimeScope({
  workspaceRoot: workspace, projectRoots: [workspace], fallbackSessionId: sessionId,
});
await runWithRuntimeScope(scope, async () => {
  if (process.env.RI_TEST_PROBE_ONLY === "1") {
    try {
      await assertRecoveryIngress("write_file", "native", input, scope);
    } catch (error) {
      if (String(error).includes("RI_RECONCILE_REQUIRED")) {
        console.log("RI_RECONCILE_REQUIRED: existing completed operation found after process restart");
        return;
      }
      throw error;
    }
    throw new Error("RI_REPLAY_WAS_NOT_BLOCKED");
  }
  const permit = await assertRecoveryIngress("write_file", "native", input, scope);
  if (!permit) throw new Error("RI_TEST_CHILD_NO_PERMIT");
  await executeOperation({
    workspaceRoot: workspace, identity: permit.identity, tool: "write_file",
    ownerSessionId: sessionId, args: input,
  }, async () => {
    await assertRecoveryWriteCommit(input);
    process.exit(73);
  });
  throw new Error("RI_TEST_CHILD_EXIT_NOT_REACHED");
});
