# Clean Beanthentic android-app build cache to free disk space.
# Safe to run anytime. Next build will re-download/recreate as needed.
# Run from PowerShell: .\clean-build-cache.ps1

$ErrorActionPreference = "SilentlyContinue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$freed = 0

if (Test-Path "build") {
    $size = (Get-ChildItem -Path "build" -Recurse | Measure-Object -Property Length -Sum).Sum
    Remove-Item -Recurse -Force "build"
    $freed += $size
    Write-Host "Removed build/"
}
if (Test-Path ".gradle") {
    $size = (Get-ChildItem -Path ".gradle" -Recurse -Force | Measure-Object -Property Length -Sum).Sum
    Remove-Item -Recurse -Force ".gradle"
    $freed += $size
    Write-Host "Removed .gradle/"
}

if ($freed -gt 0) {
    $mb = [math]::Round($freed / 1MB, 2)
    Write-Host "Freed about $mb MB. Rebuild when you need an APK again."
} else {
    Write-Host "No build cache found (already clean)."
}
