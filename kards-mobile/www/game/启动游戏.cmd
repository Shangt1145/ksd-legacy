@echo off
setlocal
title KARDS DIY
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 goto nonode

if not exist "game\tools\launch.js" goto badplace

node "game\tools\launch.js"
echo.
echo ============================================================
echo  Server stopped. Double-click this file again to play.
echo  LAN play: the window above also prints your LAN address
echo  (http://192.168.x.x:8731/...) - share it to play together.
echo ============================================================
echo.
pause
exit /b 0

:nonode
echo.
echo [ERROR] Node.js not found.
echo   1) Install the LTS version from https://nodejs.org/
echo   2) Then double-click this file again.
echo   3) Or skip the server: just open game\index.html
echo      (the game runs, but decks/cards cannot be saved)
echo.
pause
exit /b 1

:badplace
echo.
echo [ERROR] game\tools\launch.js not found.
echo   Keep this .cmd file inside the game folder.
echo.
pause
exit /b 1
