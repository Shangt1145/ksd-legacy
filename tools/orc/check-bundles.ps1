param([string]$DesktopZip,[string]$AndroidApk)
$ErrorActionPreference='Stop'
if(-not $DesktopZip -and -not $AndroidApk){throw 'Provide a DesktopZip or AndroidApk to verify'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$orcRepo=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$orcFiles=@('js/ui.js','css/style.css','js/engine.js','js/effects.js','js/effect-primitives.js','js/effect-contract.js','js/effect-editor.js','js/effect-inspector.js','css/inspector.css','css/inspector-tutorial.css','js/inspector-help.js','inspector-tutorial.html','js/orc.js','js/card-import.js','js/netsync.js','index.html','inspector.html')
function Test-OrCArchive([string]$ArchivePath,[string]$Prefix,[string]$SourcePath){
  $orcArchive=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ArchivePath))
  try {
    $orcBundleFiles=$orcFiles
    if($Prefix -eq 'assets/public/game/'){$orcBundleFiles+=@('css/touch.css','css/mobile-layout.css')}
    foreach($orcFile in $orcBundleFiles){
      $orcEntries=@($orcArchive.Entries | Where-Object {$_.FullName.Replace('\','/').EndsWith($Prefix+$orcFile,[StringComparison]::Ordinal)})
      if($orcEntries.Count -ne 1){throw "Missing or duplicate entry: $orcFile in $ArchivePath"}
      $orcStream=$orcEntries[0].Open();$orcHash=[Security.Cryptography.SHA256]::Create()
      try {$orcDigest=[Convert]::ToHexString($orcHash.ComputeHash($orcStream))} finally {$orcStream.Dispose();$orcHash.Dispose()}
      $orcExpected=(Get-FileHash -LiteralPath (Join-Path $SourcePath $orcFile) -Algorithm SHA256).Hash
      if($orcDigest -ne $orcExpected){throw "Stale bundle: $orcFile in $ArchivePath"}
    }
    Write-Host "PASS current OrC code and cache versions: $ArchivePath"
  } finally {$orcArchive.Dispose()}
}
if($DesktopZip){Test-OrCArchive $DesktopZip 'resources/app/game/' (Join-Path $orcRepo 'electron/game')}
if($AndroidApk){Test-OrCArchive $AndroidApk 'assets/public/game/' (Join-Path $orcRepo 'kards-mobile/www/game')}
