@echo off
rem Находит подходящий Node.js, а если его нет или он старый, скачивает переносную версию в папку runtime.
rem Вызывается из start.bat и demo.bat из корня программы: изменённый PATH остаётся и для них. В систему ничего не ставится.
rem Минимум 20.15 или 22.2: в более старых нет zlib.crc32, и программа не запустится.
set "NODE_VERSION=v24.18.0"
set "PATH=%CD%\runtime;%PATH%"

call :check && exit /b 0

echo Подходящего Node.js нет. Скачиваю переносную версию %NODE_VERSION% в папку runtime: один раз, около 35 МБ, нужен интернет...
powershell -NoProfile -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$ProgressPreference='SilentlyContinue';" ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "$zip=Join-Path $env:TEMP 'node-portable.zip';" ^
  "Remove-Item 'runtime','runtime-tmp' -Recurse -Force -ErrorAction SilentlyContinue;" ^
  "Invoke-WebRequest 'https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip' -OutFile $zip -UseBasicParsing;" ^
  "Expand-Archive $zip -DestinationPath 'runtime-tmp' -Force;" ^
  "Move-Item 'runtime-tmp\node-%NODE_VERSION%-win-x64' 'runtime';" ^
  "Remove-Item 'runtime-tmp',$zip -Recurse -Force"
if errorlevel 1 exit /b 1
call :check
exit /b %errorlevel%

:check
node -e "const v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=2)||(v[0]===20&&v[1]>=15)?0:1)" >nul 2>nul
exit /b %errorlevel%
