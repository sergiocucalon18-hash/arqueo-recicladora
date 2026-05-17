@echo off
cd /d "%~dp0"
if not exist node_modules (
  npm install
)
start "API Arqueo Recicladora" /min cmd /k "cd /d ""%~dp0"" && npm run server"
npm run dev
