$ErrorActionPreference = "Stop"

Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install

Write-Host "Building + packaging..." -ForegroundColor Cyan
npm run package

Write-Host "Done. Check the release folder for installers." -ForegroundColor Green
