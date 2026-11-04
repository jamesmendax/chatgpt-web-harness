# Privacy and security / 隐私与安全

**This is a local-first tool runtime with powerful permissions.** File, shell, Git, browser and desktop capabilities can touch the host Windows user session. Connect only trusted AI clients and restrict the chosen workspace whenever possible.

- Installer and portable EXEs are intended to start without a preconfigured personal account or Tunnel ID.
- Local application credentials are stored using Electron `safeStorage`; on Windows this is user-scoped protection (DPAPI-backed behavior).
- Portable data lives alongside the portable EXE in its own `.data` directory. Never copy that directory into public uploads or share it without deliberately removing secrets and session data.
- Do not commit local `.env`, `config.json`, `accounts.json`, `Cookies`, browser profiles, log files, or recovery archives.
- A public HTTPS Tunnel must protect local MCP access. Do **not** directly expose unprotected loopback ports to the internet.
- The binaries are **unsigned**, so check the Release asset SHA-256 against [RELEASE_NOTES.md](RELEASE_NOTES.md).
- This snapshot underwent targeted static privacy checks. It is not a complete independent security audit, and clean-machine Windows compatibility was not tested.

Third-party source examples and license notices may contain attribution emails or mock credential syntax. No live user credentials are intentionally included in the public source snapshot.

非官方软件，与 OpenAI、GitHub 均无隶属或背书关系。
