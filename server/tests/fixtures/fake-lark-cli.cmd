@echo off
rem Windows wrapper: run the sibling .mjs with the same base name.
rem ASCII-only on purpose: cmd.exe reads batch files with the OEM code page.
node "%~dp0%~n0.mjs" %*
exit /b %ERRORLEVEL%
