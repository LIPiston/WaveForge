@echo off
chcp 65001 > nul
echo ========================================
echo WaveForge - Full Stack Startup
echo ========================================
echo.

echo Starting Python Beat Service...
echo.
start "Python Beat Service" cmd /k "chcp 65001 >nul && cd python-beat-service && start.bat"

echo Waiting 3 seconds for Python service to initialize...
timeout /t 3 /nobreak > nul

echo.
echo Starting Electron App...
echo.
start "WaveForge Electron" cmd /k "chcp 65001 >nul && npm run dev:electron"

echo.
echo ========================================
echo All services started!
echo ========================================
echo.
echo Python Service: http://localhost:3002
echo Electron App: Will open automatically
echo.
echo To stop services, close both windows
echo.
pause
