[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$OutputDirectory = Join-Path $RepoRoot "artifacts\desktop"
$OutputExecutable = Join-Path $OutputDirectory "P4Deck.exe"

Push-Location -LiteralPath $RepoRoot
try {
    # Tauri build embeds dist into the exe. Tauri dev instead uses localhost.
    & pnpm tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) {
        throw "Desktop build failed (exit $LASTEXITCODE). Existing standalone exe was preserved."
    }
    $BuiltExecutable = Join-Path $RepoRoot "src-tauri\target\release\p4deck.exe"
    if (-not (Test-Path -LiteralPath $BuiltExecutable -PathType Leaf)) {
        throw "Desktop build did not produce $BuiltExecutable"
    }
    [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
    # Keep the double-click entry separate from targets overwritten by tauri dev.
    Copy-Item -LiteralPath $BuiltExecutable -Destination $OutputExecutable -Force
    Write-Host "Standalone desktop executable: $OutputExecutable"
} finally {
    Pop-Location
}
