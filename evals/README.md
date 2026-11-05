# Local Coder Agent Eval

This benchmark measures whether ChatGPT web can use the local MCP as a reliable coding-agent harness.

## Workflow

```powershell
npm run eval:list
npm run eval:prepare -- --task code-fix
# Give the printed prompt and run directory to ChatGPT with the MCP enabled.
npm run eval:grade -- --run <run-directory>
```

For `visual-svg`, the machine grader awards 60 structural/rendering points. The remaining 40 points belong exclusively to the user:

```powershell
npm run eval:grade -- --run <run-directory> --manual-score 32
```

`npm run eval:selftest` proves that every grader rejects the seeded broken fixture and accepts its reference solution. It does not measure the model.

Reports are written to `eval-report.json` and `eval-report.md` inside each run directory. Benchmark runs are isolated under the configured `CODEX_HOME` by default and never restart the production MCP or tunnel.