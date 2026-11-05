@echo off
title Remove Miles and Pence price collector
powershell.exe -NoProfile -Command "Unregister-ScheduledTask -TaskName 'Miles and Pence fuel prices' -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'MilesAndPence') -ErrorAction SilentlyContinue; Write-Host 'Removed the scheduled task and saved settings.'"
echo.
pause
