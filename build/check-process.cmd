@echo off
setlocal
rem 0 = running, 17 = not running, 18 = detection failed.
rem A command failure OR a failed output redirection must stop detection.
"%SystemRoot%\System32\tasklist.exe" /FI "IMAGENAME eq %~1" /FO CSV /NH > "%~2" || exit /b 18
rem Compare the first CSV field literally, removing its surrounding quotes.
rem Avoid findstr's nested escaped quotes and ambiguous file-error exit codes.
for /F "usebackq tokens=1 delims=," %%P in ("%~2") do (
  if /I "%%~P"=="%~1" exit /b 0
)
exit /b 17
