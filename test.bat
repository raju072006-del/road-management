@echo off
rem ═══════════════════════════════════════════════════════
rem  LOCAL TEST - build karke apne PC par kholta hai
rem  (online kuch nahin jaata - jitni baar chahen chalayen)
rem ═══════════════════════════════════════════════════════
cd /d "%~dp0"

echo Building...
node "build\build-local.js"
if errorlevel 1 (
  echo.
  echo ERROR - upar ka message dekhen.
  pause
  exit /b 1
)

start "" "Road Management.html"
echo.
echo Local version browser mein khul gaya (LOCAL mode - data isi PC ke browser mein).
echo Jab sab badlav theek lagein, tab  push.bat  chalayen - sab online chala jayega.
pause
