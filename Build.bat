@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo npm not found. Install Node.js from https://nodejs.org
  pause
  exit /b 1
)
echo Building Mimi Desktop...
call npm run dist
if errorlevel 1 (
  echo.
  echo Build failed. If the error mentions "symbolic link" or "required privilege":
  echo   - Enable Developer Mode: Settings ^> Privacy ^> For developers ^> Developer Mode
  echo   - Or run this batch file as Administrator (right-click ^> Run as administrator^)
  echo.
  pause
  exit /b 1
)
echo.
echo Installer created in: dist\
dir /b dist\*.exe 2>nul
pause
exit /b 0
