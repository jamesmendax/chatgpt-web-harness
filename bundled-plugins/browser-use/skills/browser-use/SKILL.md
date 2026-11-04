---
name: browser-use
description: Drive the bundled official Browser Use runtime and its isolated managed Chrome for Testing session.
metadata:
  version: 0.13.10+harness.1
---

# Browser Use

Use `browser_use_exec` for interaction that needs JavaScript rendering, navigation, clicking, typing, or a persistent browser session. Use `browser_use_screenshot` to inspect the visible result.

- The first navigation should be `new_tab(url)`. Reuse that tab across calls.
- Helpers such as `new_tab`, `goto_url`, `page_info`, `click_at_xy`, `type_text`, `js`, `wait_for_load`, and `list_tabs` are pre-imported.
- Print bounded results from Python. The namespace persists between calls.
- Prefer a direct HTTP tool for public pages that do not require browser interaction.
- The bundled browser has its own account-scoped profile. It does not attach to the user's everyday Chrome profile.
- Anonymous Browser Use and browser-harness telemetry is forced off by the launcher.

Example:

```python
new_tab("http://127.0.0.1:8080/")
wait_for_load()
print(page_info())
```

This provider pins Browser Use 0.13.10 and browser-harness 0.1.13 under their MIT licenses. The provider is independent from the relay recovery chain and from the existing Playwright browser tools.
