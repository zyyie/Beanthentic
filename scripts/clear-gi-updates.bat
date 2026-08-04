@echo off
cd /d "%~dp0.."
echo Clearing GI Updates from database...
python scripts/clear_gi_admin_updates.py
if errorlevel 1 (
  echo.
  echo Failed. Make sure Python is installed and MySQL is running on the app device.
  pause
  exit /b 1
)
echo.
pause
