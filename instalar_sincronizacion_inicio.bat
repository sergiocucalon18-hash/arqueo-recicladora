@echo off
setlocal
cd /d "%~dp0"

set "TASK_NAME=Arqueo Recicladora - Sincronizar compras"
set "TASK_SCRIPT=%~dp0iniciar_sincronizacion_mysql.bat"

echo Instalando inicio automatico de sincronizacion...
schtasks /Create /TN "%TASK_NAME%" /SC ONLOGON /RL LIMITED /F /TR "\"%TASK_SCRIPT%\""
if errorlevel 1 (
  echo.
  echo No se pudo crear la tarea automatica.
  echo Abre este archivo con clic derecho y "Ejecutar como administrador", o revisa permisos de Windows.
  pause
  exit /b 1
)

echo.
echo Listo. La sincronizacion se iniciara automaticamente cuando entres a Windows.
echo Tambien la arrancare ahora para probar.
schtasks /Run /TN "%TASK_NAME%"
echo.
echo Puedes revisar el registro en: %~dp0logs\sincronizacion-mysql.log
pause
