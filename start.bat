@echo off
chcp 65001 >nul
title Волейбол — сервер статистики
cd /d "%~dp0"

if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости...
  call npm install
)

rem Пульт откроется в браузере через 2 секунды, когда сервер уже поднимется.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:4200/"

node server.js
pause
