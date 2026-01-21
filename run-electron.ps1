$env:PATH = "C:\Program Files\nodejs;$env:PATH"
Set-Location $PSScriptRoot

Write-Host "Building Vite app..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Building Electron..." -ForegroundColor Cyan
npm run electron:build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Launching Electron..." -ForegroundColor Green
npm run electron:dev
