@echo off
setlocal
cd /d "%~dp0"
python transfer_ui.py
if errorlevel 1 pause
