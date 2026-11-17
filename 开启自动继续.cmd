@echo off
setlocal
set "ROOT=C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook"
set "NODE=C:\Users\luban\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
del /q "%ROOT%\tmp\autocontinue.stop" >nul 2>&1
echo 1>"%ROOT%\tmp\autocontinue.enabled"
start "" /min "%NODE%" "%ROOT%\tmp\autocontinue-watchdog.mjs"
echo Auto-continue enabled (max 100).
endlocal
