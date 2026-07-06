@echo off
rem ═══════════════════════════════════════════════════════
rem  PUSH - sab kuch ek command mein online:
rem   1. website build
rem   2. Supabase database structure (supabase_schema.sql)
rem   3. Netlify direct deploy -> site TURANT live (~10-30 sec)
rem   4-5. GitHub commit + push (backup / version history)
rem  Pehle test.bat se local check kar lena behtar hai.
rem ═══════════════════════════════════════════════════════
cd /d "%~dp0"

echo [1/5] Build...
node "build\build-local.js"
if errorlevel 1 goto :err

echo [2/5] Supabase database structure...
node "build\push-schema.js"
if errorlevel 1 goto :err

echo [3/5] Netlify direct deploy (site turant LIVE)...
node "build\deploy-netlify.js"
if errorlevel 1 goto :err

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Git repo setup nahin hai - site phir bhi LIVE hai; GitHub backup SKIP.
  goto :done
)

echo [4/5] Commit (GitHub backup/history)...
git add -A
git commit -m "update: %date% %time%"

echo [5/5] Push...
git push
if errorlevel 1 goto :err

:done
echo.
echo DONE - site LIVE ho gayi.
goto :end

:err
echo.
echo ERROR - upar ka message dekhen. (Online kuch adhura push nahin hua)

:end
pause
