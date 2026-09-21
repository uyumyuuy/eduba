[CmdletBinding()]
param(
  [string]$TesseractRoot = 'C:\Program Files\Tesseract-OCR',
  [string]$ModelPath = 'D:\work\assyrian-ocr\trial\runs\eng_assyriology-scan-candidate-v1-20260920\seed\eng_assyriology_scan_candidate_20260920_v1.traineddata'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'src-tauri\resources\tesseract'
$modelsDir = Join-Path $repoRoot 'src-tauri\resources\models'
New-Item -ItemType Directory -Force -Path $runtimeDir, $modelsDir | Out-Null

$exe = Join-Path $TesseractRoot 'tesseract.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw "Tesseract executable was not found at $exe. Pass -TesseractRoot to its install directory."
}
Copy-Item -LiteralPath $exe -Destination (Join-Path $runtimeDir 'tesseract.exe') -Force
Get-ChildItem -LiteralPath $TesseractRoot -Filter '*.dll' -File | Copy-Item -Destination $runtimeDir -Force

if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
  throw "traineddata model was not found at $ModelPath. Pass -ModelPath to the model file."
}
Copy-Item -LiteralPath $ModelPath -Destination $modelsDir -Force
Write-Host "Bundled Tesseract runtime into $runtimeDir"
Write-Host "Bundled OCR model into $modelsDir"
Write-Host 'PDF files are intentionally not copied into application resources.'

