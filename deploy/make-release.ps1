# Build an upload package of the ERP (for hosts without git/SSH): .\deploy\make-release.ps1
# Creates ..\sundaybazar-erp-release-<date>.zip WITHOUT .env, logs, backups, uploaded files, tests or git data.
# Upload it, unzip it on the server, keep the server's own .env, then run:  bash deploy/deploy.sh --no-pull
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
composer install --no-dev --optimize-autoloader --no-interaction
$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
$out = Join-Path (Split-Path -Parent $root) "sundaybazar-erp-release-$stamp.zip"
$stage = Join-Path $env:TEMP "sb-release-$stamp"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory $stage | Out-Null
$exclude = @('.git', '.env', 'tests', 'node_modules', '_laravel_tmp')
Get-ChildItem -Force $root | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object { Copy-Item $_.FullName -Destination $stage -Recurse -Force }
# runtime data never goes into a release
foreach ($p in 'storage\logs', 'storage\app\private', 'storage\framework\sessions', 'storage\framework\cache\data', 'storage\framework\views', 'bootstrap\cache') {
  $d = Join-Path $stage $p
  if (Test-Path $d) { Get-ChildItem $d -Force | Where-Object { $_.Name -ne '.gitignore' } | Remove-Item -Recurse -Force }
}
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $out -Force
Remove-Item $stage -Recurse -Force
composer install --no-interaction | Out-Null   # put the dev tools back for local work
Write-Host "Release package: $out"
