@echo off
title Beanthentic Server
cd /d "%~dp0"

echo Stopping old server on port 5000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R ":5000 .*LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

echo Clearing Python cache...
if exist config\__pycache__ rmdir /s /q config\__pycache__ 2>nul

echo.
echo Cross-device reminder:
echo   - Admin web.py = port 5000 on THIS PC
echo   - Beanthentic-App = port 8080 on the XAMPP PC (python app.py)
echo   - Phone Server URL must use the XAMPP PC IP :8080 (same as settings.json app_server_base)
echo   - After start, open http://YOUR-LAN-IP:5000/api/connection-status
echo.
echo Starting Beanthentic (SMS build otp-v4)...
python web.py
pause
