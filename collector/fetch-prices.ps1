# Miles & Pence price collector (Windows).
# Downloads every UK forecourt and its prices from the government Fuel Finder API
# (which only answers UK connections), then uploads one compact prices.json to the
# GitHub 'prices' branch and asks GitHub to republish the site.
# Run by a Windows scheduled task every 30 minutes. Settings live in
# %LOCALAPPDATA%\MilesAndPence\config.json, with secrets encrypted to your Windows account.
# Data: UK Government Fuel Finder scheme, Open Government Licence v3.0.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$dir = Join-Path $env:LOCALAPPDATA 'MilesAndPence'
$log = Join-Path $dir 'collector.log'
$base = 'https://www.fuel-finder.service.gov.uk/api/v1'

function Log([string]$m) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m
  Add-Content -Path $log -Value $line
  Write-Host $line
}
function Plain([string]$enc) {
  $ss = ConvertTo-SecureString $enc
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Describe($err) {
  $msg = $err.Exception.Message
  if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $msg += ' | ' + $err.ErrorDetails.Message.Substring(0, [Math]::Min(300, $err.ErrorDetails.Message.Length)) }
  return $msg
}
function StatusOf($err) {
  if ($err.Exception.Response) { return [int]$err.Exception.Response.StatusCode }
  return 0
}

# Keep the log short.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 200KB)) {
  Get-Content $log -Tail 300 | Set-Content ($log + '.tmp'); Move-Item ($log + '.tmp') $log -Force
}

$step = 'reading settings'
try {
  $cfg = Get-Content (Join-Path $dir 'config.json') -Raw | ConvertFrom-Json

  $step = 'getting a Fuel Finder access token'
  $body = @{ client_id = (Plain $cfg.clientId); client_secret = (Plain $cfg.clientSecret) } | ConvertTo-Json
  $t = Invoke-RestMethod -Method Post -Uri "$base/oauth/generate_access_token" -ContentType 'application/json' -Body $body
  if ($t.data) { $t = $t.data }
  if (-not $t.access_token) { throw 'Token response had no access_token' }
  $h = @{ Authorization = 'Bearer ' + $t.access_token; Accept = 'application/json' }

  function GetAll([string]$path) {
    $all = New-Object System.Collections.ArrayList
    for ($b = 1; $b -lt 200; $b++) {
      $r = $null
      for ($try = 0; $try -lt 4; $try++) {
        try { $r = Invoke-RestMethod -Uri ($base + $path + '?batch-number=' + $b) -Headers $h; break }
        catch {
          $code = StatusOf $_
          if ($code -eq 404 -and $all.Count -gt 0) { return ,$all }
          if ($code -eq 429 -or $code -ge 500) { Start-Sleep -Seconds (2 * ($try + 1)); continue }
          throw
        }
      }
      if ($null -eq $r) { break }
      if ($r -isnot [array] -and $null -ne $r.data) { $r = $r.data }
      $items = @($r | Where-Object { $_ -ne $null })
      [void]$all.AddRange($items)
      if ($items.Count -lt 500) { break }
      Start-Sleep -Milliseconds 700
    }
    return ,$all
  }

  $step = 'downloading forecourts'
  $stations = GetAll '/pfs'
  Start-Sleep -Milliseconds 700
  $step = 'downloading prices'
  $prices = GetAll '/pfs/fuel-prices'

  $step = 'building the price list'
  $map = @{}
  foreach ($s in $stations) {
    if ($s.permanent_closure -eq $true) { continue }
    $loc = $s.location
    if (-not $loc) { continue }
    $la = [double]$loc.latitude; $lo = [double]$loc.longitude
    if ($la -eq 0 -or $lo -eq 0) { continue }
    $name = $s.trading_name; if (-not $name) { $name = $s.brand_name }; if (-not $name) { $name = 'Fuel station' }
    $town = (@($loc.city, $loc.postcode) | Where-Object { $_ }) -join ' '
    $row = [ordered]@{ id = [string]$s.node_id; n = [string]$name; b = $s.brand_name; t = $town;
      la = [Math]::Round($la, 5); lo = [Math]::Round($lo, 5); p = [ordered]@{} }
    if ($s.temporary_closure -eq $true) { $row.x = 1 }
    $map[[string]$s.node_id] = $row
  }
  $priced = 0
  foreach ($s in $prices) {
    $row = $map[[string]$s.node_id]
    if (-not $row) { continue }
    foreach ($fp in @($s.fuel_prices)) {
      if (-not $fp -or $null -eq $fp.price -or $fp.price -eq '') { continue }
      $p = [double]$fp.price
      if ($p -le 0) { continue }
      if ($p -lt 10) { $p = $p * 100 }
      $row.p[[string]$fp.fuel_type] = [Math]::Round($p, 1)
      $ts = $fp.price_last_updated; if (-not $ts) { $ts = $fp.price_change_effective_timestamp }
      if ($ts) { $ts = [string]$ts; if (-not $row.u -or $ts -gt $row.u) { $row.u = $ts } }
    }
    if ($row.p.Count -gt 0) { $priced++ }
  }
  if ($priced -eq 0) { throw ('No prices found in ' + $prices.Count + ' price records') }

  $out = [ordered]@{
    source = 'UK Government Fuel Finder scheme (Open Government Licence v3.0)'
    fetchedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    stations = @($map.Values)
  }
  $json = $out | ConvertTo-Json -Depth 6 -Compress
  Set-Content -Path (Join-Path $dir 'prices.json') -Value $json -Encoding UTF8

  $step = 'uploading to GitHub'
  $repo = $cfg.repo
  $gh = @{ Authorization = 'Bearer ' + (Plain $cfg.githubToken); Accept = 'application/vnd.github+json';
    'User-Agent' = 'MilesAndPence-collector'; 'X-GitHub-Api-Version' = '2022-11-28' }
  $sha = $null
  try {
    $gh2 = $gh.Clone(); $gh2.Accept = 'application/vnd.github.object+json'
    $cur = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/prices.json?ref=prices" -Headers $gh2
    $sha = $cur.sha
  } catch { if ((StatusOf $_) -ne 404) { throw } }
  $put = @{ message = 'Fuel prices ' + $out.fetchedAt; branch = 'prices';
    content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)) }
  if ($sha) { $put.sha = $sha }
  Invoke-RestMethod -Method Put -Uri "https://api.github.com/repos/$repo/contents/prices.json" -Headers $gh -ContentType 'application/json' -Body ($put | ConvertTo-Json) | Out-Null

  $step = 'asking GitHub to republish the site'
  Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/actions/workflows/pages.yml/dispatches" -Headers $gh -ContentType 'application/json' -Body '{"ref":"main"}' | Out-Null

  $types = ($map.Values | ForEach-Object { $_.p.Keys } | Sort-Object -Unique) -join ', '
  Log ("OK: " + $map.Count + " stations, " + $priced + " with prices (" + $types + "), " + [Math]::Round($json.Length / 1KB) + " KB uploaded")
  exit 0
}
catch {
  Log ("FAILED while " + $step + ": " + (Describe $_))
  exit 1
}
