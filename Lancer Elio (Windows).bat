@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js n est pas installe. Telechargez-le sur https://nodejs.org ^(version LTS^), puis relancez ce fichier.
  pause
  exit /b 1
)
node server.js
pause
