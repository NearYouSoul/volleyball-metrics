@echo off
chcp 65001 >nul
title Волейбол — сервер статистики
cd /d "%~dp0"

rem Ставим зависимости при первом запуске и после обновления (например, когда добавился FFmpeg для видео).
rem Нужен интернет один раз — дальше всё работает без него.
if not exist node_modules\ffmpeg-static\package.json (
  echo Устанавливаю зависимости — один раз, нужен интернет...
  call npm install
)

rem Пульт откроется в браузере через 2 секунды, когда сервер уже поднимется.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:4200/"

node server.js
pause
