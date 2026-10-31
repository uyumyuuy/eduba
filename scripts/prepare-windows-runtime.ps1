[CmdletBinding()]
param([string]$SevenZipPath = 'C:\Program Files\7-Zip\7z.exe')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtime = Get-Content -LiteralPath (Join-Path $repoRoot 'config/windows-runtime.json') -Raw | ConvertFrom-Json
if ($runtime.repository -notmatch '^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$' -or
    $runtime.tag -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$' -or
    $runtime.asset -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.exe$' -or
    $runtime.sha256 -notmatch '^[a-f0-9]{64}$' -or $runtime.size -le 0 -or
    $runtime.version -notmatch '^\d+\.\d+\.\d+$') {
  throw 'Invalid config/windows-runtime.json.'
}
if (-not (Test-Path -LiteralPath $SevenZipPath -PathType Leaf)) {
  throw "7-Zip is required. Pass -SevenZipPath to its 7z.exe. GitHub's Windows runner includes it."
}

$cache = Join-Path $repoRoot ".cache/windows-runtime/$($runtime.sha256)"
New-Item -ItemType Directory -Force -Path $cache | Out-Null
$installer = Join-Path $cache $runtime.asset
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  $partial = Join-Path $cache "$([guid]::NewGuid()).partial"
  try {
    $url = "https://github.com/$($runtime.repository)/releases/download/$($runtime.tag)/$($runtime.asset)"
    Invoke-WebRequest -Uri $url -OutFile $partial -MaximumRetryCount 3 -RetryIntervalSec 2
    if ((Get-Item -LiteralPath $partial).Length -ne $runtime.size -or
        (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.sha256) {
      throw 'Downloaded Tesseract installer does not match its pinned size/SHA-256.'
    }
    Move-Item -LiteralPath $partial -Destination $installer
  } finally {
    if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
  }
}
if ((Get-Item -LiteralPath $installer).Length -ne $runtime.size -or
    (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtime.sha256) {
  throw 'Cached Tesseract installer does not match its pinned size/SHA-256.'
}

# Extract without installing Tesseract or changing the runner's registry/PATH.
$extracted = Join-Path $cache "extracted-$([guid]::NewGuid())"
& $SevenZipPath x -y "-o$extracted" $installer
if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned Tesseract installer.' }
$executables = @(Get-ChildItem -LiteralPath $extracted -Recurse -File -Filter 'tesseract.exe')
if ($executables.Count -ne 1) { throw 'Expected one Tesseract executable in the installer.' }
$sourceRoot = $executables[0].DirectoryName
$license = Join-Path $sourceRoot 'doc/LICENSE'
if (-not (Test-Path -LiteralPath $license -PathType Leaf)) { throw 'Tesseract license text is missing.' }
$libraries = @(Get-ChildItem -LiteralPath $sourceRoot -File -Filter '*.dll')
if (-not $libraries.Count) { throw 'Tesseract runtime DLLs are missing.' }
$destination = Join-Path $repoRoot 'src-tauri/resources/tesseract'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
if ((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint) {
  throw 'The runtime resource directory must not be a link.'
}
# Replace generated binaries instead of writing over files potentially linked to
# an earlier Cargo resource copy. Also discard obsolete DLLs from older runtimes.
Get-ChildItem -LiteralPath $destination -File | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Force
}
Copy-Item -LiteralPath $executables[0].FullName -Destination $destination -Force
foreach ($library in $libraries) { Copy-Item -LiteralPath $library.FullName -Destination $destination -Force }
foreach ($file in @($executables[0]) + $libraries) {
  if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -ne
      (Get-FileHash -LiteralPath (Join-Path $destination $file.Name) -Algorithm SHA256).Hash) {
    throw "Tesseract resource copy did not preserve the file hash: $($file.Name)"
  }
}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'doc') -Destination $destination -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'config/windows-runtime.json') -Destination (Join-Path $destination 'RUNTIME-PROVENANCE.json') -Force
$banner = (& (Join-Path $destination 'tesseract.exe') --version 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $banner -notmatch "(?m)^tesseract v?$([regex]::Escape($runtime.version))([.\s]|$)") {
  throw "The bundled runtime could not report the pinned Tesseract version: $banner"
}
Write-Host $banner
Write-Host "Prepared verified Windows OCR runtime in $destination"
