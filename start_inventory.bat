@echo off
cd /d "%~dp0"
if exist "%~dp0InventoryServer.exe" (
    start "" "%~dp0InventoryServer.exe"
    exit /b
)
python app.py
pause
