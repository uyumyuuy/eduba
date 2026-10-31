[CmdletBinding()]
param(
  [string]$TesseractRoot = 'C:\Program Files\Tesseract-OCR',
  [string]$ModelPath = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'src-tauri\resources\tesseract'
$modelsDir = Join-Path $repoRoot 'src-tauri\resources\models'
if (-not $ModelPath) {
  $model = Get-Content -LiteralPath (Join-Path $repoRoot 'config/web-model.json') -Raw | ConvertFrom-Json
  $ModelPath = Join-Path $modelsDir $model.asset
}
New-Item -ItemType Directory -Force -Path $runtimeDir, $modelsDir | Out-Null

$exe = Join-Path $TesseractRoot 'tesseract.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
  throw "Tesseract executable was not found at $exe. Pass -TesseractRoot to its install directory."
}
Copy-Item -LiteralPath $exe -Destination (Join-Path $runtimeDir 'tesseract.exe') -Force
Get-ChildItem -LiteralPath $TesseractRoot -Filter '*.dll' -File | Copy-Item -Destination $runtimeDir -Force
if (Test-Path -LiteralPath (Join-Path $TesseractRoot 'doc') -PathType Container) {
  Copy-Item -LiteralPath (Join-Path $TesseractRoot 'doc') -Destination $runtimeDir -Recurse -Force
}

if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
  throw "traineddata model was not found at $ModelPath. Pass -ModelPath to the model file."
}
$modelDestination = Join-Path $modelsDir (Split-Path -Leaf $ModelPath)
if ([IO.Path]::GetFullPath($ModelPath) -ne [IO.Path]::GetFullPath($modelDestination)) {
  Copy-Item -LiteralPath $ModelPath -Destination $modelDestination -Force
}
Write-Host "Bundled Tesseract runtime into $runtimeDir"
Write-Host "Bundled OCR model into $modelsDir"
Write-Host 'PDF files are intentionally not copied into application resources.'

