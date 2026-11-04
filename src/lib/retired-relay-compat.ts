import { currentRelayGoal, ensureRelayGoalStorage, readRelayStateText, withRelayGoalTransition } from "./relay-scope.js";
import { driverLeasePath, readDriverLease } from "./driver-lease.js";
import { writeTextFileCas } from "./safe-text-write.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

/** Retired Relay is entered only to fence pre-existing, attributable state.
 * The existing implementation owns lease, command and worker identity checks;
 * this adapter never starts polling, provisioning or any browser action. */
export async function fenceRetiredRelayIfPresent(workspaceRoot: string, goalId: string): Promise<boolean> {
  return withRelayGoalTransition(workspaceRoot, currentRelayGoal(workspaceRoot), goalId, async () => {
    // readRelayStateText rejects ambiguous legacy records and verifies scope.
    const records = await Promise.all(["driver-lease.json", "manager.json", "workers.json"]
      .map(file => readRelayStateText(workspaceRoot, file)));
    if (records.every(record => record === null)) return false;
    // The retired normal lease release intentionally no-ops. Migrate only
    // attributable old data and revoke the exact validated lease with CAS.
    await ensureRelayGoalStorage(workspaceRoot);
    const leaseFile = driverLeasePath(workspaceRoot, goalId);
    const leaseBytes = await fs.readFile(leaseFile, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (leaseBytes !== null) {
      const validated = await readDriverLease(workspaceRoot, goalId);
      if (!validated || validated.goal_id !== goalId || JSON.stringify(validated) !== JSON.stringify(JSON.parse(leaseBytes))) {
        throw new Error("RELAY_COMPAT_LEASE_CHANGED: reconcile the legacy lease before superseding");
      }
      if (validated.state !== "RELEASED") {
        const now = new Date().toISOString();
        await writeTextFileCas(leaseFile, JSON.stringify({ ...validated, state: "RELEASED", renewed_at: now,
          expires_at: now, prepared_handoff_id: null }, null, 2) + "\n", {
          expectedSha256: createHash("sha256").update(leaseBytes).digest("hex"),
        });
      }
    }
    const { fenceSupersededRelayGoal } = await import("./relay-manager.js");
    await fenceSupersededRelayGoal(workspaceRoot, goalId);
    return true;
  });
}
