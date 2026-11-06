@echo off
REM RE:KG - set the AI translation key (ASCII only: cmd parses this file as GBK)
REM Double-click me, paste your sk-... key, then fully restart RE:KG.
cd /d "%~dp0"
node "scripts\set-llm-key.mjs" %*
echo.
pause
