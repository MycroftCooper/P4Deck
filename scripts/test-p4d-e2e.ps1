[CmdletBinding()]
param(
    [ValidateRange(1, 10)]
    [int]$Repeat = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$FixtureScript = Join-Path $PSScriptRoot "p4d-fixture.ps1"
$FixtureRoot = Join-Path $RepoRoot ".tools\p4d-fixture"
$P4 = Join-Path $FixtureRoot "bin\p4.exe"
$P4d = Join-Path $FixtureRoot "bin\p4d.exe"
$Tickets = Join-Path $FixtureRoot "tickets"
$Trust = Join-Path $FixtureRoot "trust"
$Enviro = Join-Path $FixtureRoot "p4enviro"
$Workspace = Join-Path $FixtureRoot "e2e-workspace"
$Server = "127.0.0.1:16661"
$User = "p4deck-fixture-admin"
$Client = "p4deck-fixture-e2e"

if (-not (Test-Path -LiteralPath $P4 -PathType Leaf) -or
    -not (Test-Path -LiteralPath $P4d -PathType Leaf)) {
    Write-Warning "SKIP BE-002 localhost E2E: pinned p4/p4d fixture tools are missing. Run 'pnpm fixture:setup:win'."
    exit 0
}

function Test-FixturePort {
    $socket = [Net.Sockets.TcpClient]::new()
    try {
        $task = $socket.ConnectAsync("127.0.0.1", 16661)
        return $task.Wait(300) -and $socket.Connected
    }
    catch {
        return $false
    }
    finally {
        $socket.Dispose()
    }
}

$wasRunning = Test-FixturePort
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $FixtureScript start
if ($LASTEXITCODE -ne 0) {
    throw "Could not start the verified localhost p4d fixture."
}

$environmentNames = @(
    "P4PORT", "P4USER", "P4CLIENT", "P4CHARSET", "P4CONFIG", "P4TICKETS", "P4TRUST",
    "P4ENVIRO", "P4PASSWD", "P4DECK_E2E", "P4DECK_E2E_P4", "P4DECK_E2E_SERVER",
    "P4DECK_E2E_USER", "P4DECK_E2E_CLIENT", "P4DECK_E2E_TICKETS", "P4DECK_E2E_TRUST",
    "P4DECK_E2E_ROOT"
)
$previous = @{}
foreach ($name in $environmentNames) {
    $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    $previous[$name] = if ($null -eq $item) { $null } else { $item.Value }
}

try {
    $env:P4PORT = $Server
    $env:P4USER = $User
    $env:P4CLIENT = $Client
    $env:P4CHARSET = "none"
    $env:P4CONFIG = ".p4deck-e2e-disabled"
    $env:P4TICKETS = $Tickets
    $env:P4TRUST = $Trust
    $env:P4ENVIRO = $Enviro
    Remove-Item -LiteralPath Env:P4PASSWD -ErrorAction SilentlyContinue

    $env:P4DECK_E2E = "1"
    $env:P4DECK_E2E_P4 = $P4
    $env:P4DECK_E2E_SERVER = $Server
    $env:P4DECK_E2E_USER = $User
    $env:P4DECK_E2E_CLIENT = $Client
    $env:P4DECK_E2E_TICKETS = $Tickets
    $env:P4DECK_E2E_TRUST = $Trust
    $env:P4DECK_E2E_ROOT = $Workspace

    for ($run = 1; $run -le $Repeat; $run++) {
        Write-Host "BE-002 localhost application E2E run $run/$Repeat"
        & cargo test --manifest-path (Join-Path $RepoRoot "src-tauri\Cargo.toml") --lib `
            "e2e::tests::localhost_fixture_exercises_application_services" -- `
            --ignored --exact --nocapture --test-threads=1
        if ($LASTEXITCODE -ne 0) {
            throw "BE-002 localhost application E2E run $run failed."
        }
    }
}
finally {
    foreach ($name in $environmentNames) {
        if ($null -eq $previous[$name]) {
            Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -LiteralPath "Env:$name" -Value $previous[$name]
        }
    }
    if (-not $wasRunning) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $FixtureScript stop
    }
}
