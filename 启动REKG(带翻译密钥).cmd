@echo off
REM RE:KG - launch the installed app with the AI translation key injected (ASCII only)
REM Does not write any registry / system setting.
cd /d "%~dp0"
node "scripts\launch-rekg-with-key.mjs" %*
echo.
pause
