@echo off
setlocal
cd /d "%~dp0"

if not exist logs mkdir logs
set "LOG_FILE=%~dp0logs\sincronizacion-mysql.log"
set "ERROR_LOG_FILE=%~dp0logs\sincronizacion-mysql-error.log"

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
set "RUN_LOG_FILE=%~dp0logs\sincronizacion-mysql-run-%RANDOM%%RANDOM%.log"

if not exist node_modules (
  echo [%date% %time%] Falta node_modules. Ejecuta npm install antes de activar el inicio automatico.>> "%LOG_FILE%"
  exit /b 1
)

echo [%date% %time%] Log de esta ejecucion: %RUN_LOG_FILE%>> "%LOG_FILE%"
set "STARTER=%TEMP%\almetales-mysql-sync-%RANDOM%%RANDOM%.vbs"
> "%STARTER%" echo Set shell = CreateObject("WScript.Shell")
>> "%STARTER%" echo shell.CurrentDirectory = "%CD%"
>> "%STARTER%" echo shell.Run "cmd.exe /c """"%NODE_EXE%"" backend\server.js ^>^> ""%RUN_LOG_FILE%"" 2^>^> ""%ERROR_LOG_FILE%""""", 0, False
wscript.exe //B "%STARTER%"
del "%STARTER%" >nul 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 3"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4000/health' -TimeoutSec 3; if ($r.StatusCode -eq 200) { exit 0 } } catch { exit 1 }"
if errorlevel 1 (
  echo [%date% %time%] No se pudo confirmar que la API quedo encendida. Revisa este log.>> "%LOG_FILE%"
  exit /b 1
)

echo [%date% %time%] Sincronizacion MySQL encendida en segundo plano.>> "%LOG_FILE%"
