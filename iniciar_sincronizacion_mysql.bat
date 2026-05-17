@echo off
setlocal
cd /d "%~dp0"

if not exist logs mkdir logs
set "LOG_FILE=%~dp0logs\sincronizacion-mysql.log"

echo.>> "%LOG_FILE%"
echo [%date% %time%] Iniciando sincronizacion MySQL -> Firestore...>> "%LOG_FILE%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4000/health' -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } } catch { exit 1 }"
if not errorlevel 1 (
  echo [%date% %time%] La API ya estaba encendida.>> "%LOG_FILE%"
  exit /b 0
)

set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE_EXE%" (
  set "NODE_EXE=node"
)

if not exist node_modules (
  echo [%date% %time%] Falta node_modules. Ejecuta npm install antes de activar el inicio automatico.>> "%LOG_FILE%"
  exit /b 1
)

"%NODE_EXE%" backend\server.js >> "%LOG_FILE%" 2>&1
