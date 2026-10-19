@echo off
cd /d "%~dp0"
echo Starting Glaido Pro for Windows...
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0windows-agent\glaido-win-agent.ps1"
