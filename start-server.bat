@echo off
chcp 65001 >nul
title DebiX Studio 3D v2.0 — Local Server (http://localhost:3000)
cd /d "%~dp0"

echo ========================================================
echo   Запуск локального сервера DebiX Studio 3D v2.0
echo   Адрес: http://localhost:3000
echo ========================================================
echo.

REM Открываем браузер через 2 секунды после старта npx serve
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:3000"

REM Запускаем npx serve строго на порту 3000
call npx serve -l 3000

pause
