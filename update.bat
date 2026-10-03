@echo off
rem DMX Show Controller - update this copy to the latest version on GitHub.
rem Close the engine window first. Your shows, songs and output settings are not touched.
setlocal
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git was not found. Install Git for Windows from https://git-scm.com/download/win,
  echo then run this file again.
  pause
  exit /b 1
)

for /f "delims=" %%V in ('git describe --tags --always 2^>nul') do set "BEFORE=%%V"
echo This copy is at version %BEFORE%. Checking GitHub for a newer one...
echo.

rem A copy that was sent back to an older version (git checkout v0.3.2) returns to main first.
git switch main >nul 2>nul
git pull --ff-only
if errorlevel 1 (
  echo.
  echo The update could not be applied: this copy has changes of its own, or GitHub could
  echo not be reached. Nothing was changed. Do not use this copy for development; ask for help
  echo before a show.
  pause
  exit /b 1
)

for /f "delims=" %%V in ('git describe --tags --always 2^>nul') do set "AFTER=%%V"
echo.
if "%BEFORE%"=="%AFTER%" (
  echo Already up to date: version %AFTER%.
) else (
  echo Updated from %BEFORE% to %AFTER%. Start the program again to use it.
)
pause
