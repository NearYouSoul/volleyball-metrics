@echo off
chcp 65001 >nul
title Волейбол — ДЕМО
cd /d "%~dp0"

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости...
  call npm install
)

rem Демо-матчи пишутся в отдельную папку demo-data — настоящие данные в data не трогаются.
node scripts\demo.js --dir demo-data --force

rem Сразу открываем студию.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:4200/studio.html"

node server.js --data demo-data
pause
