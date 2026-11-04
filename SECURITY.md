# Security boundaries

This application can expose powerful local filesystem and shell capabilities through MCP. Only grant access to trusted accounts and tools. Profiles separate configuration, state and owned processes, not Windows security identities. Use separate OS users or virtual machines for mutually untrusted users.

Never publish real runtime keys, administrative tokens, account configuration, userData or private tunnel endpoints. Report security problems privately with redacted reproduction steps. No private reporting address is invented by this source bundle.

The bundled tunnel-client is independently checksum-verified against its upstream release. This is provenance verification, not a claim that the entire application is vulnerability-free. This release is not code-signed. See VALIDATION.json and dependency audit artifacts for the measured scope.
