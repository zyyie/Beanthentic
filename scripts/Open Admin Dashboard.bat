@echo off
REM Opens the admin on HTTP (camera works). Do NOT use https:// in the browser.
start "" "http://127.0.0.1:5000/dashboard"
echo Opened http://127.0.0.1:5000/dashboard
echo If the browser shows a certificate error, you used https by mistake.
echo Close that tab and run this file again, or type http://127.0.0.1:5000 in the address bar.
