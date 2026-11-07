@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (echo Node.js tidak ditemukan. Lihat README bagian Laragon. & pause & exit /b 1)
if not exist node_modules call npm install
if not exist data\kost.db call npm run seed
echo.
echo Buka http://localhost:3000  (dari HP: http://IP-LAPTOP:3000)
call npm start
pause
