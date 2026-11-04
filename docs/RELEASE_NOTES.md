# Release notes · 3.1.0-alpha.2

Date: 2026-11-04 · Channel: **public prerelease** · Platform: **Windows 10/11 x64** (theoretical compatibility; no second-machine test)

## Downloads

| Asset | SHA-256 |
| --- | --- |
| `ChatGPT Web Harness Isolated-3.1.0-alpha.2-setup.exe` | `63c815f61f8c598685c3bfee48a59e833cc6cae932ecdf4d611b782d65142bb6` |
| `ChatGPT Web Harness Isolated-3.1.0-alpha.2-portable.exe` | `ca3ec04d6368477ff63407da209ad216971fb94cad96dd97b624c3e914ca9d9c` |

The Setup and portable executables are unsigned. Your Windows account must provide compatible Electron safeStorage/DPAPI support for encrypted local credentials.

## Highlights

- Aura visual refinements, unified themed dropdown menus, reduced always-visible helper text.
- Account transfer/dialog improvements; session controls stay bound to the right account.
- More actionable errors for argument validation, request admission, review readiness and tool execution.
- Computer Use rejects unstarted native calls without blocking subsequent window selection.
- Goal/Task process ownership recovery and Windows Chrome process handoff improvements.
- Skills selection and loading remain task-dependent, not guaranteed autonomous model actions.

## Verification scope

Existing local build record reports 132 backend test scripts and desktop regression chain passed; both EXEs were unpacked and compared against the packaged runtime, and the UI files were matched to the reviewed source. A later static privacy scan found no packaged user-account data or plaintext private API credentials. The checked public source tree is curated and deliberately excludes selected test examples that resemble credentials.

**Not verified:** separate clean Windows install, code-signing / SmartScreen reputation, final live ChatGPT/Tunnel end-to-end acceptance, macOS/Linux/ARM runtime.

## Security

Do not download or distribute a `portable.data` folder, cached browser profiles, local logs or credentials with these executables. Full local tool access must be entrusted only to a trusted client and a deliberately chosen workspace.

See [PRIVACY_AND_SECURITY.md](PRIVACY_AND_SECURITY.md) for the local-data model.
