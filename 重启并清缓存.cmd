@echo off
setlocal
set "APP=D:\DeepSeekHarness\DeepSeek Harness.exe"
set "ROOT=C:\Users\luban\Documents\deepseek-harness\default-workspace\SourceLook"
taskkill /IM "DeepSeek Harness.exe" /F >nul 2>&1
timeout /t 2 /nobreak >nul
for %%D in (
  "%APPDATA%\DeepSeek Harness\Cache"
  "%APPDATA%\DeepSeek Harness\Code Cache"
  "%APPDATA%\DeepSeek Harness\GPUCache"
  "%APPDATA%\DeepSeek Harness\DawnCache"
  "%APPDATA%\DeepSeek Harness\ShaderCache"
  "%LOCALAPPDATA%\DeepSeek Harness\Cache"
  "%LOCALAPPDATA%\DeepSeek Harness\Code Cache"
) do if exist "%%~D" rd /s /q "%%~D" >nul 2>&1
start "" "%APP%" --remote-debugging-port=9222
endlocal
