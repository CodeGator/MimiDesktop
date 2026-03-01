@echo off
cd /d "%~dp0"
set "EXE=dist\win-unpacked\Mimi Desktop.exe"
if exist "%EXE%" (
  start "" "%EXE%"
) else (
  echo Exe not found. Run Build.bat first, or: npm start
  start "" cmd /c "npm start"
)
exit /b 0
