@echo off
:: Run as Administrator on the ADMIN PC (where web.py runs)
netsh advfirewall firewall add rule name="Beanthentic Admin 5000" dir=in action=allow protocol=TCP localport=5000
echo Done. Rule added for TCP 5000.
pause
