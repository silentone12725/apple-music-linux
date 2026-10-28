@echo off
setlocal
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" || exit /b 1
cd /d "%~dp0"
cl /nologo /EHsc /std:c++17 /LD /I"C:\Program Files (x86)\Windows Kits\10\Include\10.0.28000.0\cppwinrt" composition-backdrop.cpp /link /OUT:composition-backdrop.dll dwmapi.lib windowsapp.lib CoreMessaging.lib user32.lib comctl32.lib d2d1.lib
exit /b %ERRORLEVEL%
