@echo off
rem REKG one-click launcher: KuGou API (source, lite mode) + local server + browser
rem NOTE: keep this file ASCII-only. cmd.exe parses it in the system codepage (GBK on zh-CN Windows).
cd /d %~dp0

rem Skip the API if port 3000 is already LISTENING
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo [OK] KuGou API already running
) else (
    echo Starting KuGou API (lite) ...
    start "KuGou API" cmd /k "cd /d %~dp0api && node app.js --platform=lite"
)

timeout /t 2 /nobreak >nul

rem Local server (static pages + play-url resolver); keep the console window for logs
start "REKG Server" cmd /k node server.js

timeout /t 2 /nobreak >nul
start "" http://localhost:3001
