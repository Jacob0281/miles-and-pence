# Miles & Pence price collector: one-off setup.
# Asks for your Fuel Finder credentials and a GitHub token, stores them encrypted to your
# Windows account, runs a first price fetch, then schedules it every 30 minutes.

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'MilesAndPence'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'fetch-prices.ps1') -Destination $dir -Force

Write-Host ''
Write-Host 'Miles & Pence price collector setup' -ForegroundColor Yellow
Write-Host 'Paste each value and press Enter. Nothing shows as you paste: that is normal.'
Write-Host 'They are stored encrypted, readable only by your Windows account.'
Write-Host ''

function Ask([string]$label) {
  while ($true) {
    $v = Read-Host $label -AsSecureString
    if ($v.Length -gt 0) { return $v }
    Write-Host 'That was empty, please paste it again.' -ForegroundColor Red
  }
}
$id = Ask 'Fuel Finder Client ID'
$secret = Ask 'Fuel Finder Client Secret'
$token = Ask 'GitHub token (starts github_pat_)'

$cfg = [ordered]@{
  repo = 'Jacob0281/miles-and-pence'
  clientId = ConvertFrom-SecureString $id
  clientSecret = ConvertFrom-SecureString $secret
  githubToken = ConvertFrom-SecureString $token
}
$cfg | ConvertTo-Json | Set-Content -Path (Join-Path $dir 'config.json') -Encoding UTF8

Write-Host ''
Write-Host 'Running a first price fetch (about a minute)...' -ForegroundColor Yellow
$script = Join-Path $dir 'fetch-prices.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script
$ok = ($LASTEXITCODE -eq 0)

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $script + '"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Miles and Pence fuel prices' -Action $action -Trigger $trigger -Settings $settings -Description 'Collects UK fuel prices for the Miles & Pence app every 30 minutes.' -Force | Out-Null

Write-Host ''
if ($ok) {
  Write-Host 'All set. Prices will update every 30 minutes while this computer is on.' -ForegroundColor Green
} else {
  Write-Host 'The first fetch failed (see the message above). The schedule is set up anyway;' -ForegroundColor Red
  Write-Host 'tell Claude what the message says.' -ForegroundColor Red
}
Write-Host ('Log file: ' + (Join-Path $dir 'collector.log'))
