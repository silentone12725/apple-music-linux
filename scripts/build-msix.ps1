<#
.SYNOPSIS
  Builds a sideload MSIX of Adam: electron\dist\adam-<version>.msix, signed with your own certificate.

.DESCRIPTION
  Uses electron-builder's appx target with a config generated from electron\package.json (the NSIS installer config is
  not touched). The package declares adam:// and the Apple Music schemes (uap3:Protocol with Parameters, so the link arrives as a
  command-line argument), so they appear under Settings -> Apps -> Default apps, as with the NSIS installer.

  Prerequisites: run scripts\build-windows.ps1 first (with -SkipInstaller if you only want the MSIX): this script packs
  the runtime folder it leaves in electron\dist\resources-win. The Windows SDK (makeappx.exe) must be installed.

  The certificate's subject must equal the package publisher, so the publisher is read from the .pfx. An expired
  certificate stops the build. A sideloaded MSIX only installs where the certificate (.cer) is trusted, e.g. imported
  into Cert:\LocalMachine\TrustedPeople. It is not suitable for the Microsoft Store: Adam downloads Apple's libraries.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-msix.ps1 -Pfx "C:\certs\Silent One.pfx" -PfxPasswordFile "C:\certs\Silent One.pfx.pwd"
#>
param(
    [Parameter(Mandatory)][string]$Pfx,
    [string]$PfxPasswordFile = '',        # a text file holding the password (a trailing line break is ignored)
    [securestring]$PfxPassword = $null,   # or the password itself
    [string]$IdentityName = 'SilentOne.Adam'
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path "$PSScriptRoot\..").Path
$Electron = Join-Path $Repo 'electron'
$Cfg = Join-Path $Electron 'electron-builder.msix.json'

if (-not (Test-Path $Pfx)) { throw "certificate not found: $Pfx" }
if ($PfxPasswordFile) { $plain = (Get-Content $PfxPasswordFile -Raw).Trim() }
elseif ($PfxPassword) { $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($PfxPassword)) }
else { throw 'pass -PfxPasswordFile or -PfxPassword' }

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Pfx, $plain)
if (-not $cert.HasPrivateKey) { throw 'the .pfx has no private key' }
if ($cert.NotAfter -le (Get-Date)) { throw "the certificate expired on $($cert.NotAfter)" }
$publisher = $cert.Subject
Write-Host "Signing as '$publisher' (thumbprint $($cert.Thumbprint), valid until $($cert.NotAfter.ToString('yyyy-MM-dd')))"

if (-not (Test-Path "$Electron\dist\resources-win\engine.exe")) { throw 'electron\dist\resources-win is missing: run scripts\build-windows.ps1 -SkipInstaller first' }
foreach ($t in 'node', 'npx') { if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { throw "'$t' is required but not on PATH" } }

# electron-builder's bundled signtool cannot sign MSIX packages ("A required function is not present"), so use the SDK's.
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName | Select-Object -Last 1
if (-not $signtool) { throw 'signtool.exe (Windows SDK) not found under Windows Kits\10\bin' }

# The config: package.json's build section with an appx target in place of NSIS, plus the link schemes.
$gen = @'
const fs = require('fs');
const [,, pfx, publisher, identity, out, hook] = process.argv;
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const b = pkg.build;
b.win = { ...b.win, target: [{ target: 'appx', arch: ['x64'] }], artifactName: 'adam-${version}.${ext}', signtoolOptions: { certificateFile: pfx, sign: hook, signingHashAlgorithms: ['sha256'] } };
delete b.nsis;
delete b.protocols; // the uap3 entries below replace it; a scheme name must be unique within a package
// Inside a package the engine does not find libvlc.dll / libvlccore.dll through PATH, only beside engine.exe.
// Adam still points VLC_PLUGIN_PATH at vlc\plugins.
b.win.extraResources = [...b.win.extraResources,
    { from: 'dist/resources-win/vlc/libvlc.dll', to: 'libvlc.dll' },
    { from: 'dist/resources-win/vlc/libvlccore.dll', to: 'libvlccore.dll' }];
b.appx = { identityName: identity, publisher, publisherDisplayName: 'Silent One', displayName: 'Adam', applicationId: 'Adam', languages: ['en-US'], backgroundColor: 'transparent' };
import(require('url').pathToFileURL(require('path').resolve('deeplink.mjs')).href).then((m) => {
    // electron-builder's own `protocols` option writes uap:Protocol, which hands the URI to the app only as an
    // activation payload (AppInstance.GetActivatedEventArgs), never on the command line. Microsoft documents
    // uap3:Protocol Parameters (Windows 10 1607+, full-trust packaged apps) to pass it as an argument, which is
    // where Electron's second-instance / process.argv reads it. See learn.microsoft.com ... element-uap3-protocol.
    const ns = 'http://schemas.microsoft.com/appx/manifest/uap/windows10/3';
    const schemes = [m.OWN_SCHEME, ...m.APPLE_SCHEMES.filter(s => !s.windowsOnly).map(s => s.scheme)];
    // The app execution alias (adam.exe on PATH) is how launch at login passes --hidden to the package: its Startup
    // shortcut targets it (electron/startup.mjs, MSIX_ALIAS).
    const alias = `<uap3:Extension xmlns:uap3="${ns}" Category="windows.appExecutionAlias" Executable="app\\Adam.exe" EntryPoint="Windows.FullTrustApplication"><uap3:AppExecutionAlias><desktop:ExecutionAlias Alias="adam.exe" /></uap3:AppExecutionAlias></uap3:Extension>`;
    fs.writeFileSync('dist/msix-extensions.xml', schemes.map(s =>
        `<uap3:Extension xmlns:uap3="${ns}" Category="windows.protocol"><uap3:Protocol Name="${s}" Parameters="&quot;%1&quot;"><uap:DisplayName>Adam</uap:DisplayName></uap3:Protocol></uap3:Extension>`).concat(alias).join('\n'));
    b.appx.customExtensionsPath = 'dist/msix-extensions.xml';
    fs.writeFileSync(out, JSON.stringify(b, null, 2));
});
'@
# The signing hook electron-builder calls for every file: the SDK signtool, by thumbprint (no password on a command line).
$hookSrc = @'
const { execFileSync } = require('child_process');
module.exports = async (config) => {
    const run = (extra) => execFileSync(process.env.ADAM_SIGNTOOL, ['sign', '/fd', 'SHA256', '/sha1', process.env.ADAM_SIGN_THUMBPRINT, '/d', 'Adam', ...extra, config.path], { stdio: 'pipe' });
    try { run(['/tr', 'http://timestamp.digicert.com', '/td', 'SHA256']); }
    catch { run([]); } // no timestamp server reachable: the signature is then valid for the certificate's lifetime
};
'@
Push-Location $Electron
$imported = $null
$madeBuildDir = -not (Test-Path "$Electron\build")
try {
    # Package logos: generated from the app icon by scripts\make-msix-assets.py. electron-builder reads them from
    # <buildResources>\appx and otherwise falls back to its own generic icon.
    New-Item -ItemType Directory -Force "$Electron\build\appx" | Out-Null
    Copy-Item "$Electron\msix-assets\*.png" "$Electron\build\appx" -Force
    # Import the certificate for the build; it is removed again at the end.
    $imported = Import-PfxCertificate -FilePath $Pfx -CertStoreLocation Cert:\CurrentUser\My -Password (ConvertTo-SecureString $plain -AsPlainText -Force)
    $env:ADAM_SIGNTOOL = $signtool.FullName
    $env:ADAM_SIGN_THUMBPRINT = $imported.Thumbprint
    $hookSrc | Set-Content "$Electron\dist\msix-sign.cjs" -Encoding utf8
    $gen | Set-Content "$Electron\dist\gen-msix-config.cjs" -Encoding utf8
    node "$Electron\dist\gen-msix-config.cjs" $Pfx $publisher $IdentityName $Cfg "$Electron\dist\msix-sign.cjs"
    $env:CSC_KEY_PASSWORD = $plain
    Get-ChildItem dist\*.appx, dist\*.msix -ErrorAction SilentlyContinue | Remove-Item -Force
    npx electron-builder --win appx --config $Cfg
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($LASTEXITCODE)" }
    $pkgFile = Get-ChildItem dist\adam-*.appx | Select-Object -First 1
    if (-not $pkgFile) { throw 'no .appx was produced' }
    # An .appx and an .msix are the same package format; Windows opens either.
    $msix = [IO.Path]::ChangeExtension($pkgFile.FullName, '.msix')
    Move-Item $pkgFile.FullName $msix -Force
    $sig = Get-AuthenticodeSignature $msix
    Write-Host "Done: $msix ($([math]::Round((Get-Item $msix).Length / 1MB, 1)) MB)"
    Write-Host "Signature: $($sig.Status) by $($sig.SignerCertificate.Subject)  (NotTrusted is expected until the .cer is trusted on the machine)"
}
finally {
    Remove-Item Env:\CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:\ADAM_SIGNTOOL, Env:\ADAM_SIGN_THUMBPRINT -ErrorAction SilentlyContinue
    if ($imported) { Remove-Item "Cert:\CurrentUser\My\$($imported.Thumbprint)" -Force -ErrorAction SilentlyContinue }
    if ($madeBuildDir) { Remove-Item "$Electron\build" -Recurse -Force -ErrorAction SilentlyContinue }
    else { Remove-Item "$Electron\build\appx" -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item $Cfg, "$Electron\dist\gen-msix-config.cjs", "$Electron\dist\msix-sign.cjs", "$Electron\dist\msix-extensions.xml" -Force -ErrorAction SilentlyContinue
    Pop-Location
}
