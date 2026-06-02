@echo off
title Beanthentic Server
cd /d "%~dp0"

echo Stopping old server on port 5000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":5000 .*LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

echo Clearing Python cache...
if exist config\__pycache__ rmdir /s /q config\__pycache__ 2>nul

echo Starting Beanthentic (SMS build otp-v4)...
python web.py
pause
