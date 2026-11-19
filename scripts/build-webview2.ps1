# Builds the WebView2-bundled edition of CSVSSE as a zip:
#   release-out\CSVSSE-<version>-webview2-x64.zip
#     CSVSSE\CSVSSE.exe
#     CSVSSE\webview2\...   (WebView2 Fixed Version Runtime)
#     CSVSSE\LICENSE
#
# Usage:
#   npm run build:webview2 -- -Runtime "<extracted Microsoft.WebView2.FixedVersionRuntime.*.x64 folder>"
#
# Get the runtime (.cab, x64) from https://developer.microsoft.com/microsoft-edge/webview2/
# ("Fixed Version") and extract it with:  expand.exe <file>.cab -F:* <folder>
# Afterwards the standard (non-bundled) exe is rebuilt so target\release\CSVSSE.exe
# is the normal edition again.

param(
    [Parameter(Mandatory = $true)][string]$Runtime
)
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not (Test-Path (Join-Path $Runtime "msedgewebview2.exe"))) {
    throw "msedgewebview2.exe が見つかりません: $Runtime"
}
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

# tauri-build expects the runtime at src-tauri\webview2 (git-ignored).
$buildRuntime = Join-Path $root "src-tauri\webview2"
if (Test-Path $buildRuntime) { Remove-Item -Recurse -Force $buildRuntime }
Copy-Item -Recurse $Runtime $buildRuntime

Write-Host "== Building bundled edition $version"
npx tauri build --no-bundle --config src-tauri/tauri.webview2.conf.json
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$out = Join-Path $root "release-out"
$stage = Join-Path $out "CSVSSE"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item "src-tauri\target\release\CSVSSE.exe" $stage
Copy-Item "LICENSE" $stage
Copy-Item -Recurse $Runtime (Join-Path $stage "webview2")

$zip = Join-Path $out "CSVSSE-$version-webview2-x64.zip"
Write-Host "== Zipping $zip"
tar.exe -a -c -f $zip -C $out CSVSSE
if ($LASTEXITCODE -ne 0) { throw "zip failed" }

Write-Host "== Rebuilding standard edition"
npx tauri build --no-bundle
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Write-Host "== Done: $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
