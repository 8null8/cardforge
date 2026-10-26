@echo off
rem Drag a list .txt onto this file to get one PNG image per card (or double-click it and paste links).
setlocal
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% "%~dp0cardforge_png.py" %*
echo.
pause
