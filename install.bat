@echo off
setlocal
chcp 65001 >nul

rem Печатает готовый фрагмент конфига для плагина Proxy Router.
rem Скрипт ничего не перезаписывает: опции живут в %CONFIG_DIR%\opencode.json,
rem и правку делает пользователь.

set "SRC=%~dp0plugin"
set "CONFIG_DIR=%USERPROFILE%\.config\opencode"
set "PLUGIN_PATH=%SRC:\=/%"
set "CONFIG=%CONFIG_DIR%\opencode.json"

if not exist "%SRC%\index.js" (
  echo [ERROR] Не найден "%SRC%\index.js". Запустите install.bat из папки проекта.
  pause
  exit /b 1
)

if not exist "%CONFIG%" (
  echo [ERROR] Не найден "%CONFIG%". Запустите OpenCode хотя бы раз.
  pause
  exit /b 1
)

echo.
echo Добавьте в "%CONFIG%" в массив "plugins" такой объект:
echo.
echo     {
echo       "package": "%PLUGIN_PATH%",
echo       "options": {
echo         "proxy": "socks5h://proxy.example.com:1080",
echo         "models": ["opencode-go/beam-free", "opencode-go/muse-spark-1.3-contributor"],
echo         "enabled": true
echo       }
echo     }
echo.
echo Прокси и список моделей замените на свои. Подробности — в README.md.
echo После сохранения конфиг перезагрузится сам; проверка: /proxy status
echo.

choice /c YN /m "Открыть opencode.json в блокноте"
if errorlevel 2 goto :end
notepad "%CONFIG%"

:end
echo.
pause
