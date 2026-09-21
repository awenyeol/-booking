@echo off
cd /d %~dp0
echo Starting RGSG IHS G11 Booking Internal Test...
where py >nul 2>nul
if %errorlevel%==0 (
  py server.py
) else (
  python server.py
)
pause
