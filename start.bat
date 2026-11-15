@echo off
cd /d "%~dp0"
call conda run --no-capture-output -n mc_env python run.py %*
pause
