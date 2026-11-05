# API

`computer_use` accepts `action`. Selection uses `target` and optional decimal `hwnd`. Pointer actions use `x`, `y`, `to_x`, `to_y`, and `button`. Typing uses `text`; set `replace_existing=true` to select, clear, and replace the focused field within one native helper invocation. Keypress uses `key` or `keys`; scrolling uses `delta_x` and `delta_y`; waiting uses `duration_ms`.
