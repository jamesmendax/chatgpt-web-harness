@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0desktop\node_modules\electron\dist\electron.exe" "%~dp0desktop\scripts\start-isolated.cjs"
if errorlevel 1 pause
endlocal
