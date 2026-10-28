$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 or newer first: https://nodejs.org' }
$configDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'ctrlwrite_config'
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
$siteFile = Join-Path $configDirectory 'site.txt'
$siteOrigin = if (Test-Path -LiteralPath $siteFile) { [IO.File]::ReadAllText($siteFile).Trim() } else { '' }
$enteredOrigin = Read-Host "Website origin (https://your-domain), Enter to keep [$siteOrigin]"
if ($enteredOrigin.Trim()) { $siteOrigin = $enteredOrigin.Trim().TrimEnd('/') }
if (-not $siteOrigin) { throw 'A website origin is required.' }
[IO.File]::WriteAllText($siteFile, $siteOrigin)
$env:IAMTIRED_SITE_ORIGIN = $siteOrigin
$env:IAMTIRED_CANVAS_DATA_DIR = Join-Path $configDirectory 'bridge'
& node (Join-Path $PSScriptRoot 'bridge.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Local service stopped with an error.' }
