---
name: codex-execution
description: Run long local engineering tasks with explicit state, checkpoints, visible progress, bounded verification, and a hard deliverable-ready stop condition.
---
# Codex-style execution loop

Use this skill for multi-step local work that will take several tool calls, touch multiple files, or need testing/verification.

## Start

1. Inspect the relevant project context and path rules before editing unfamiliar code.
2. For a substantial task, create a durable task with `task_create`.
3. Record two separate check lists:
   - **Blocking checks**: failures that make the deliverable unusable or unsafe to ship.
   - **Advisory checks**: optional polish that must not delay delivery after blocking checks pass.
4. Keep the current step specific enough that a future chat can resume from `task_status` without needing the old conversation.

## Work loop

Work in small batches:

1. Inspect only the files/evidence needed for the next decision.
2. Make one coherent change batch.
3. Run the cheapest relevant structural check.
4. Update the durable task after meaningful progress, including produced artifacts and the next step.
5. Surface important partial findings instead of staying silent through a long tool sequence.

Do not repeatedly rerun successful writes, builds, or tests just for reassurance.

## Verification budget

Default to at most:

- one structural/machine verification round (build, lint, schema, unit tests), and
- one real runtime/render verification round.

If both pass, stop. Do not create an endless chain of "one more check" unless new evidence reveals a real defect.

## Deliverable-ready rule

Call `task_complete` when all blocking checks pass. Advisory checks are allowed to remain incomplete.

Once the task is deliverable-ready:

- report the usable result immediately;
- do not withhold an existing deliverable for optional polish;
- only resume modification if a new defect is found or the user asks for more work.

## Recovery

After a new chat, reconnect, or MCP restart:

1. Use `task_list` if the task id is unknown.
2. Use `task_status(task_id)` to recover the goal, current step, checks, notes, and artifacts.
3. Inspect current filesystem/git state before assuming an interrupted command completed.
4. Continue from the persisted checkpoint instead of reconstructing the plan from memory.
