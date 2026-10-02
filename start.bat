@echo off
rem DMX Show Controller - double-click to start the engine and open the app.
rem Pass --host 0.0.0.0 to let tablets on the network connect, e.g.  start.bat --host 0.0.0.0
setlocal
cd /d "%~dp0"

set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE (
  for %%E in (Community Professional Enterprise) do (
    for %%V in (18 2022) do (
      if not defined NODE if exist "%ProgramFiles%\Microsoft Visual Studio\%%V\%%E\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe" (
        set "NODE=%ProgramFiles%\Microsoft Visual Studio\%%V\%%E\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe"
      )
    )
  )
)
if not defined NODE (
  echo Node.js was not found.
  echo Install the LTS version from https://nodejs.org, then run this file again.
  pause
  exit /b 1
)

if not exist "samples\demo-128bpm.wav" "%NODE%" tools\make-demo-audio.js

rem Open the browser a moment after the engine starts.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8080/"
"%NODE%" server\index.js %*
echo.
echo The engine has stopped.
pause
