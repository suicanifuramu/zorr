@echo off
echo Starting Map Server and Bot Client...
echo.

:: Start map server in background
echo [1/2] Starting Map Server on port 3000...
start /B node map_server.js

:: Wait a moment for server to start
timeout /t 2 /nobreak >nul

:: Start bot client
echo [2/2] Starting Bot Client...
echo.
node bot_client.js %*

pause
