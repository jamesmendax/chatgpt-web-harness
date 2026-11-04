$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm.cmd --prefix desktop ci
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm.cmd --prefix desktop run dist
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Output 'Build complete: desktop/release'
