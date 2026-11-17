@echo off
setlocal
set "ROOT=C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook"
set "TMP=%ROOT%\tmp"
if exist "%TMP%\autocontinue.watchdog.pid" (
  set /p PID=<"%TMP%\autocontinue.watchdog.pid"
  taskkill /PID %PID% /F >nul 2>&1
  del /q "%TMP%\autocontinue.watchdog.pid" >nul 2>&1
)
del /q "%TMP%\autocontinue.enabled" >nul 2>&1
echo stopped>"%TMP%\autocontinue.stop"
echo Auto-continue stopped.
endlocal
