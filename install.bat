@echo off
setlocal

REM install.bat — copy the /inspector-gadget.rr slash command into %USERPROFILE%\.claude\commands\
REM Idempotent: re-running overwrites the existing copy. Double-click to run.
REM
REM The tool itself is NOT copied — the slash command is pinned to
REM C:\Projects\inspector-gadget\tools\inspector-gadget\index.mjs. If the repo
REM lives elsewhere on this machine, edit the `Locate the tool` step of
REM .claude\commands\inspector-gadget.rr.md before installing.

set "REPO=%~dp0"
set "DST_CMD=%USERPROFILE%\.claude\commands"

echo Installing /inspector-gadget slash command into %DST_CMD%\
echo.

if not exist "%DST_CMD%" mkdir "%DST_CMD%"

robocopy "%REPO%.claude\commands" "%DST_CMD%" inspector-gadget.rr.md /NJH /NJS /NP /R:1 /W:1 >nul
if errorlevel 8 goto :err
echo   command:  %DST_CMD%\inspector-gadget.rr.md

echo.
echo done.  /inspector-gadget.rr is now available from any project.
echo        The tool stays in this repo at tools\inspector-gadget\ — no copy.
echo        First run on a .NET target builds the helper (one-time, a few seconds).
pause
exit /b 0

:err
echo.
echo error: robocopy failed (exit code %errorlevel%)
pause
exit /b 1
