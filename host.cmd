@echo off
REM Basit baslatma: cift tikla. Gerekirse bagimliliklari kurar ve sunucuyu+tuneli baslatir.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ gerekli. Indir: https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Bagimliliklar kuruluyor...
  call npm install
  if errorlevel 1 ( pause & exit /b 1 )
)

call npm run host
pause
