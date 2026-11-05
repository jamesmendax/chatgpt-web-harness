---
name: project-engineering
description: Modify real codebases with Codex-like repository awareness: inspect instructions and dependencies, make narrow patches, run the project’s own tests, preserve git state, and report concrete artifacts.
---
# Project engineering workflow

Use this skill for coding, debugging, refactoring, deployment preparation, repository maintenance, and release work.

## Repository awareness

Before editing unfamiliar code:

1. inspect the top-level tree and package/build metadata;
2. read `AGENTS.md`, `CLAUDE.md`, or equivalent project instructions;
3. load path-scoped rules for files you will edit;
4. inspect git status so existing user changes are not mistaken for your own;
5. search targeted symbols before reading large files wholesale.

Prefer `glob` + `grep` + targeted `read_text_file` over dumping large trees or logs.

## Editing

- Prefer `apply_patch` for coherent code changes.
- Keep changes narrow and reversible.
- Use existing project conventions and dependencies before introducing new ones.
- Do not overwrite unrelated user changes.
- Let checkpoint/rewind protect MCP-tracked edits, but do not rely on it instead of understanding git state.

## Testing

Use the project’s own build/test/lint scripts where available.

A good default sequence is:

1. compile/type/schema check;
2. focused tests for changed behavior;
3. one real execution/integration check when behavior depends on runtime environment.

Read only the relevant error range when a command fails. Fix the root cause; do not repeatedly rerun unchanged failing commands.

## Web/UI projects

After build/runtime success, use `capture_webpage` for visual correctness. A green build does not prove the interface is correct.

## Binary and generated artifacts

Verify true file type/signature when relevant. For visual output, render/open it and inspect pixels rather than relying on successful export.

## Completion

Summarize:

- what changed;
- what passed;
- exact files/artifacts created or modified;
- anything still blocking use.

If a durable task exists, update it throughout the workflow and complete it as soon as all blocking checks pass.
