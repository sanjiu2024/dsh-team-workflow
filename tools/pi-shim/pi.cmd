@echo off
REM pi shim - magic-context PiSubagentRunner calls this via cmd.exe /d /s /c.
REM Real logic lives in pi.mjs (keep this file ASCII-only; cmd.exe reads it as GBK).
setlocal
node "%~dp0pi.mjs" %*
exit /b %ERRORLEVEL%
