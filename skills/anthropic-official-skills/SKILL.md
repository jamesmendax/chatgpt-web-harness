---
name: anthropic-official-skills
description: Anthropic 官方 Agent Skills 集合的统一入口。Use when a task matches one of the 14 bundled Anthropic official skills: frontend design, algorithmic art, brand guidelines, canvas design, theme styling, web artifacts, web app testing, MCP server building, Claude API/SDK, skill creation, internal communications, Slack GIFs, Claude Academy learning guidance, or discernment nudges. Before applying a subskill, read its bundled ANTHROPIC-SKILL.md and follow its supporting references/scripts in that same directory.
---

# Anthropic Official Skills

This is a single-entry dispatcher for the Apache-licensed subset of Anthropic's official Skills repository:

- Upstream: https://github.com/anthropics/skills
- Upstream commit: `ca45fc4`
- Included skills: 14
- Upstream skill instructions are preserved under `references/skills/<skill-id>/ANTHROPIC-SKILL.md`.
- Per-skill `LICENSE.txt` files and `THIRD_PARTY_NOTICES.md` are retained.

## How to use this package

1. Match the user's task against `references/skills-index.md`.
2. When a skill is a strong match, read that skill's complete `ANTHROPIC-SKILL.md` before planning or editing.
3. Treat that file as the authoritative task-specific instructions. Do not rely only on the short index description.
4. Resolve any relative file references (such as `scripts/`, `references/`, `assets/`, `templates/`, or `examples/`) relative to that skill's own directory under `references/skills/<skill-id>/`.
5. Inspect scripts before running them. Run only the specific helper needed for the user's task; do not execute package scripts or install dependencies automatically.
6. Preserve the user's existing project files and constraints. If the upstream skill's workflow conflicts with a direct user instruction or higher-priority safety rule, follow the higher-priority instruction.

## Included official skills

- `academy-guide`
- `algorithmic-art`
- `brand-guidelines`
- `canvas-design`
- `claude-api`
- `discernment-nudge`
- `frontend-design`
- `internal-comms`
- `mcp-builder`
- `skill-creator`
- `slack-gif-creator`
- `theme-factory`
- `web-artifacts-builder`
- `webapp-testing`

## Explicit exclusions

This package intentionally excludes:

- `docx`, `pdf`, `pptx`, and `xlsx`: their upstream LICENSE.txt files explicitly prohibit extracting or retaining copies outside Anthropic Services.
- `doc-coauthoring`: no explicit per-skill license file was present in the upstream repository.
- `template`: no explicit license file was present; it is a template rather than an included skill.

Do not claim that this package provides Anthropic's restricted document-generation skills. Use the separate official Claude services where those capabilities are licensed.

## Provenance and limitations

Anthropic's repository describes these skills as demonstration/educational examples; behavior in another agent runtime may differ from Claude. This dispatcher adapts discovery to Web Harness while preserving each included skill's instructions and supporting files. It is not an Anthropic-certified integration.
