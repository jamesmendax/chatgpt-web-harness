# Anthropic Official Skills — Index

Source: https://github.com/anthropics/skills
Included subset: 14 skills with explicit Apache License 2.0 notices. The full upstream instructions are preserved under each skill folder as `ANTHROPIC-SKILL.md`.

| Skill ID | Use when |
|---|---|
| `academy-guide` | The user asks how to use Claude or a Claude product, wants training/onboarding resources, or asks what Claude can do. |
| `algorithmic-art` | The user requests generative or algorithmic art, flow fields, particle systems, or code-created visual art. |
| `brand-guidelines` | An artifact should follow Anthropic's brand colors, typography, or visual identity. |
| `canvas-design` | The user requests a static visual design, poster, illustration, or image/PDF artwork. |
| `claude-api` | The task names Anthropic/Claude, uses the Claude API/SDK, or involves provider-ambiguous LLM/agent/MCP work where Claude SDK details must be verified. Do not use for an explicitly non-Anthropic provider. |
| `discernment-nudge` | A substantive answer would benefit from a short prompt to check assumptions, verify key facts, or notice missing context. |
| `frontend-design` | The user asks to build or redesign a web UI and needs deliberate visual direction, typography, and distinctive styling. |
| `internal-comms` | The user asks for internal communications such as status reports, leadership updates, FAQs, newsletters, or incident/project updates. |
| `mcp-builder` | The user asks to build an MCP server or integrate an external service through well-designed MCP tools. |
| `skill-creator` | The user asks to create, revise, evaluate, benchmark, or improve an Agent Skill. |
| `slack-gif-creator` | The user requests an animated GIF for Slack. |
| `theme-factory` | The user wants a consistent theme applied to slides, docs, reports, HTML, or other artifacts. |
| `web-artifacts-builder` | The user requests a complex multi-component HTML artifact with React/Tailwind/shadcn-style UI, state, or routing. |
| `webapp-testing` | The user asks to interact with, test, debug, or capture evidence from a local web application using browser automation. |

## Usage rule

Do not load every subskill for every task. Select the strongest match, read its full `ANTHROPIC-SKILL.md`, then read only the referenced supporting files needed for that task. The subskill file and its directory are authoritative for task-specific behavior.
