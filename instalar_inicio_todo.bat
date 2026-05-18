@echo off
setlocal
cd /d "%~dp0"

set "SYNC_TASK=Arqueo Recicladora - Sincronizar compras"
set "APP_TASK=Arqueo Recicladora - Abrir app"
set "SYNC_SCRIPT=%~dp0iniciar_sincronizacion_mysql.bat"
set "APP_SCRIPT=%~dp0abrir_app_web.bat"

echo Instalando inicio automatico de ALMETALES...

schtasks /Create /TN "%SYNC_TASK%" /SC ONLOGON /RL LIMITED /F /TR "\"%SYNC_SCRIPT%\""
if errorlevel 1 (
  echo No se pudo instalar la sincronizacion automatica.
  pause
  exit /b 1
)

schtasks /Create /TN "%APP_TASK%" /SC ONLOGON /RL LIMITED /F /TR "\"%APP_SCRIPT%\""
if errorlevel 1 (
  echo No se pudo instalar la apertura automatica de la app.
  pause
  exit /b 1
)

echo.
echo Listo. Al entrar a Windows se iniciara la sincronizacion y se abrira la app.
echo.
echo Probando sincronizacion ahora...
schtasks /Run /TN "%SYNC_TASK%"
echo.
pause
