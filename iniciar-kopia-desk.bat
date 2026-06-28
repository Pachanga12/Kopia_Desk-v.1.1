@echo off
setlocal
cd /d "%~dp0"
echo Iniciando Kopia Desk...
echo.
echo Abre esta direccion en Chrome o Edge:
echo http://127.0.0.1:4178/
echo.
where python >nul 2>nul
if %errorlevel%==0 (
  python server.py
  exit /b
)

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 server.py
  exit /b
)

echo No encontre Python en este equipo.
echo Tambien puedes abrir index.html directamente en Chrome o Edge.
pause
