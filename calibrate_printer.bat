@echo off
rem Prints a test page to measure how far your printer shifts the back side, then saves the correction.
setlocal
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
%PY% "%~dp0cardforge.py" --calibrate --open %*
echo.
pause
