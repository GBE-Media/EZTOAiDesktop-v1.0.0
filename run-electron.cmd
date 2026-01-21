@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
npm run build
if %errorlevel% neq 0 exit /b %errorlevel%
npm run electron:build
if %errorlevel% neq 0 exit /b %errorlevel%
npm run electron:dev
