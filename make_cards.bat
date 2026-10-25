@echo off
rem Drag a list .txt (exported from the Tampermonkey script) onto this file, or double-click to paste links.
setlocal
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% "%~dp0cardforge.py" %*
echo.
pause
