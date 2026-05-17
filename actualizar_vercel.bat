@echo off
setlocal
cd /d "%~dp0"

set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
if not exist "%GIT_EXE%" (
  set "GIT_EXE=git"
)

echo Verificando cambios del proyecto...
"%GIT_EXE%" status --short
if errorlevel 1 (
  echo.
  echo No se pudo ejecutar Git. Revisa que Git este instalado.
  pause
  exit /b 1
)

echo.
echo Preparando archivos para GitHub...
"%GIT_EXE%" add .
if errorlevel 1 (
  echo.
  echo No se pudieron preparar los archivos.
  pause
  exit /b 1
)

echo.
echo Creando commit...
"%GIT_EXE%" commit -m "Actualiza app de arqueo y compras"
if errorlevel 1 (
  echo.
  echo No se creo commit. Puede que no haya cambios nuevos o que Git necesite configurar usuario.
  echo Si te pide nombre/correo, ejecuta:
  echo git config --global user.name "Sergio"
  echo git config --global user.email "tu-correo@example.com"
  pause
  exit /b 1
)

echo.
echo Subiendo a GitHub. Vercel debe desplegar automaticamente despues de esto...
"%GIT_EXE%" push origin main
if errorlevel 1 (
  echo.
  echo No se pudo subir a GitHub. Revisa que tengas sesion iniciada en GitHub o permisos del repositorio.
  pause
  exit /b 1
)

echo.
echo Listo. Revisa Vercel en 1 a 3 minutos y recarga el link.
pause
