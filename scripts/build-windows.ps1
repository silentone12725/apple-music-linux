<#
.SYNOPSIS
  Builds the Windows installer: dist\adam-setup-<version>.exe

.DESCRIPTION
  1. libdrm_client.dll      mingw32-make -C drm            (drm_linux.c + libcrypto)
  2. engine.exe             go build (CGO, adamplay_backend tag, libvlc)
  3. runtime DLLs           libcrypto and its MSYS2 UCRT64 dependencies
  4. VLC runtime subset     libvlc.dll, libvlccore.dll and the audio-side plugins
  5. renderer bundles       verified present (committed; Linux CI checks they are fresh)
  6. NSIS installer         electron-builder --win

  Prerequisites: MSYS2 UCRT64 (gcc, make, openssl) on PATH, Go, Node, a 64-bit VLC 3.x install,
  and git (to fetch the libvlc headers, which the VLC installer does not ship).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -VlcDir D:\vlc -SkipInstaller
#>
param(
    [string]$VlcDir = 'C:\Program Files\VideoLAN\VLC',
    [string]$VlcInclude = '',      # a directory containing vlc\vlc.h; fetched from VideoLAN's git when empty
    [string]$Msys = 'C:\msys64\ucrt64\bin',
    [switch]$SkipInstaller
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path "$PSScriptRoot\..").Path
$Electron = Join-Path $Repo 'electron'
$Out = Join-Path $Electron 'dist\resources-win'

function Need($cmd) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "'$cmd' is required but not on PATH" } }
foreach ($t in 'go', 'node', 'npm', 'gcc', 'mingw32-make') { Need $t }
if (-not (Test-Path "$VlcDir\libvlc.dll")) { throw "libvlc.dll not found in $VlcDir (install 64-bit VLC 3.x or pass -VlcDir)" }
if (-not (Test-Path "$Msys\libcrypto-3-x64.dll")) { throw "libcrypto-3-x64.dll not found in $Msys (pacman -S mingw-w64-ucrt-x86_64-openssl)" }
$Version = (Get-Content "$Electron\package.json" -Raw | ConvertFrom-Json).version
Write-Host "Building Adam $Version for Windows..."

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force $Out | Out-Null

# cgo cannot take -I/-L paths containing spaces, so reach everything through spaceless junctions.
$Link = Join-Path $env:TEMP 'adam-build'
if (Test-Path $Link) { Remove-Item -Recurse -Force $Link }
New-Item -ItemType Directory $Link | Out-Null
cmd /c mklink /J "$Link\vlc" "$VlcDir" | Out-Null
cmd /c mklink /J "$Link\drm" "$Repo\drm" | Out-Null

# ── 1. DRM client DLL ────────────────────────────────────────────────────────
Write-Host '[1/6] libdrm_client.dll'
mingw32-make -C "$Repo\drm" libdrm_client.dll | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'DRM client build failed' }

# ── 2. Engine ────────────────────────────────────────────────────────────────
Write-Host '[2/6] engine.exe'
if (-not $VlcInclude) {
    $VlcInclude = Join-Path $env:TEMP 'adam-vlc-headers'
    if (-not (Test-Path "$VlcInclude\vlc\vlc.h")) {
        Need git
        $tmp = Join-Path $env:TEMP 'adam-vlc-src'
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
        git clone --depth 1 --branch 3.0.21 https://code.videolan.org/videolan/vlc.git $tmp
        if ($LASTEXITCODE -ne 0) { throw 'could not fetch the libvlc headers' }
        New-Item -ItemType Directory -Force "$VlcInclude\vlc" | Out-Null
        Copy-Item "$tmp\include\vlc\*.h" "$VlcInclude\vlc"
        (Get-Content "$tmp\include\vlc\libvlc_version.h.in" -Raw) `
            -replace '@VERSION_MAJOR@', '3' -replace '@VERSION_MINOR@', '0' -replace '@VERSION_REVISION@', '21' `
            -replace '@VERSION_EXTRA@', '0' -replace '@VERSION@', '3.0.21' |
            Set-Content "$VlcInclude\vlc\libvlc_version.h"
        Remove-Item -Recurse -Force $tmp
    }
}
cmd /c mklink /J "$Link\inc" "$VlcInclude" | Out-Null
$env:CGO_ENABLED = '1'
$env:CC = 'gcc'
$env:CGO_CFLAGS = "-I$($Link -replace '\\','/')/inc"
$env:CGO_LDFLAGS = "-L$($Link -replace '\\','/')/vlc -L$($Link -replace '\\','/')/drm"
Push-Location "$Repo\engine"
try {
    go build -tags adamplay_backend -ldflags '-w -s' -trimpath -o "$Out\engine.exe" .\cmd
    if ($LASTEXITCODE -ne 0) { throw 'engine build failed' }
} finally { Pop-Location }

# ── 3. Runtime DLLs ──────────────────────────────────────────────────────────
Write-Host '[3/6] runtime DLLs'
Copy-Item "$Repo\drm\libdrm_client.dll" $Out
# libcrypto plus whatever MSYS2 DLLs it (transitively) imports; system DLLs are skipped.
$queue = [System.Collections.Queue]::new(); $queue.Enqueue('libcrypto-3-x64.dll'); $seen = @{}
while ($queue.Count) {
    $dll = $queue.Dequeue()
    if ($seen[$dll]) { continue }; $seen[$dll] = $true
    $path = Join-Path $Msys $dll
    if (-not (Test-Path $path)) { continue }
    Copy-Item $path $Out
    & "$Msys\objdump.exe" -p $path | Select-String 'DLL Name' | ForEach-Object { $queue.Enqueue(($_ -split ':')[1].Trim()) }
}

# ── 4. VLC runtime subset ────────────────────────────────────────────────────
Write-Host '[4/6] VLC subset'
$vlcOut = Join-Path $Out 'vlc'
New-Item -ItemType Directory -Force "$vlcOut\plugins" | Out-Null
Copy-Item "$VlcDir\libvlc.dll", "$VlcDir\libvlccore.dll" $vlcOut
foreach ($d in 'access', 'audio_filter', 'audio_mixer', 'audio_output', 'codec', 'demux', 'packetizer', 'stream_filter', 'control', 'misc') {
    if (Test-Path "$VlcDir\plugins\$d") { Copy-Item "$VlcDir\plugins\$d" "$vlcOut\plugins\$d" -Recurse }
}
# The cache lists the full plugin set; a stale one makes VLC rescan on every start, so drop it.
Remove-Item "$vlcOut\plugins\plugins.dat" -ErrorAction SilentlyContinue

# Minimal FFmpeg: the engine runs it for music-video remux and export. Prebuilt and committed
# (scripts/build-ffmpeg-windows.sh regenerates it), so the app needs nothing installed.
$ff = Join-Path $Repo 'third_party\ffmpeg-win'
if (-not (Test-Path "$ff\bin\ffmpeg.exe")) { throw "third_party\ffmpeg-win\bin\ffmpeg.exe is missing (git lfs pull, or run scripts/build-ffmpeg-windows.sh from an MSYS2 UCRT64 shell)" }
Copy-Item $ff (Join-Path $Out 'ffmpeg') -Recurse

# The window blur: a native Windows Composition backdrop (electron\native). It is a build output, not committed;
# electron-builder packs it as resources\composition-backdrop.dll. Needs Visual Studio 2022 Build Tools and the
# Windows 10/11 SDK (the C++/WinRT headers), see native\build-composition-backdrop.cmd.
$Backdrop = Join-Path $Electron 'native\composition-backdrop.dll'
if (-not (Test-Path $Backdrop)) {
    Write-Host '      building composition-backdrop.dll'
    cmd /c "`"$Electron\native\build-composition-backdrop.cmd`""
    if (-not (Test-Path $Backdrop)) { throw 'composition-backdrop.dll was not built (install Visual Studio 2022 Build Tools with the Windows SDK)' }
}

# ── 5. Renderer bundles ──────────────────────────────────────────────────────
Write-Host '[5/6] renderer bundles'
Push-Location $Electron
try {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
    # npm 11 skips install scripts until approved; fetch the Electron binary ourselves if needed.
    if (-not (Test-Path 'node_modules\electron\dist\electron.exe')) { node node_modules\electron\install.js }
    # The injected bundles are committed and rebuilt by scripts/build-renderer.sh (bash) on Linux,
    # where CI checks they are current. Here they only have to exist.
    foreach ($b in 'engine-bundle.js', 'engine-sse-bundle.js', 'smart-cache-bundle.js', 'vision-bundle.js') {
        if (-not (Test-Path "$Electron\$b") -or (Get-Item "$Electron\$b").Length -eq 0) { throw "electron\$b is missing; run scripts/build-renderer.sh on Linux and commit it" }
    }

    if ($SkipInstaller) { Write-Host "Skipped installer. Resources are in $Out"; return }

    # ── 6. Installer ─────────────────────────────────────────────────────────
    Write-Host '[6/6] electron-builder --win'
    npx electron-builder --win nsis
    if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
} finally { Pop-Location }
Write-Host "Done: $Electron\dist\adam-setup-$Version.exe"
