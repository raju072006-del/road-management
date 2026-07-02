@echo off
rem ═══════════════════════════════════════════════════════
rem  Ek-command deploy:  build + git push  = site update
rem  Pehli baar ka setup: README-DEPLOY.md dekhein
rem ═══════════════════════════════════════════════════════
cd /d "%~dp0"

echo [1/3] Build...
node "build\build-local.js"
if errorlevel 1 goto :err

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo.
  echo Git repo abhi setup nahin hai - sirf build hua hai.
  echo Online push ke liye README-DEPLOY.md ka one-time setup karein.
  goto :end
)

echo [2/3] Commit...
git add -A
git commit -m "update: %date% %time%"

echo [3/3] Push...
git push
if errorlevel 1 goto :err

echo.
echo DONE - 1-2 minute mein site update ho jayegi.
goto :end

:err
echo.
echo ERROR - upar ka message dekhein.

:end
pause
