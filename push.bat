@echo off
rem ═══════════════════════════════════════════════════════
rem  PUSH - sab kuch ek command mein online:
rem   1. website build
rem   2. Supabase database structure (supabase_schema.sql)
rem   3. GitHub push  ->  Netlify auto-deploy (1-2 minute)
rem  Pehle test.bat se local check kar lena behtar hai.
rem ═══════════════════════════════════════════════════════
cd /d "%~dp0"

echo [1/4] Build...
node "build\build-local.js"
if errorlevel 1 goto :err

echo [2/4] Supabase database structure...
node "build\push-schema.js"
if errorlevel 1 goto :err

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Git repo setup nahin hai - README-DEPLOY.md dekhen.
  goto :end
)

echo [3/4] Commit...
git add -A
git commit -m "update: %date% %time%"

echo [4/4] Push...
git push
if errorlevel 1 goto :err

echo.
echo DONE - 1-2 minute mein site update ho jayegi.
goto :end

:err
echo.
echo ERROR - upar ka message dekhen. (Online kuch adhura push nahin hua)

:end
pause
