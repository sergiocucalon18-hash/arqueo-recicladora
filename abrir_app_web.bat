@echo off
setlocal

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 8; Start-Process 'https://arqueo-recicladora.vercel.app'"
