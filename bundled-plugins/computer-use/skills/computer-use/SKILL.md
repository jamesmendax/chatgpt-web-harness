---
name: computer-use
description: Control an explicitly selected Windows desktop or application window using the bundled Harness Computer Use provider.
metadata:
  version: 1.0.0
---

# Harness Computer Use

Use the `computer_use` tool only when a task requires visible Windows UI interaction.

1. Call `status`, then `list_windows`.
2. Call `select_target` with `target="window"` and a decimal `hwnd`, or explicitly select `target="desktop"`.
3. Call `screenshot` before choosing coordinates. Coordinates are relative to the selected target.
4. Use `click`, `double_click`, `move`, `type`, `scroll`, `keypress`, `drag`, or `wait`.
5. Call `close` when the target should be forgotten.

Never guess a window handle or reuse one after the application restarts. Re-list and re-select it. A key chord that can close or lock the target requires explicit user confirmation and `confirmed=true`. Typed text is represented in the audit log only by length and SHA-256.

This is the project-owned MIT provider. It follows the public OpenAI computer action vocabulary but is not the proprietary Codex Computer Use plugin.
