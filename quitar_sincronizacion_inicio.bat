@echo off
setlocal

set "TASK_NAME=Arqueo Recicladora - Sincronizar compras"

echo Quitando inicio automatico de sincronizacion...
schtasks /Delete /TN "%TASK_NAME%" /F
if errorlevel 1 (
  echo.
  echo No se pudo eliminar la tarea. Puede que no exista o que Windows pida permisos.
  pause
  exit /b 1
)

echo.
echo Listo. La sincronizacion ya no se iniciara automaticamente con Windows.
pause
