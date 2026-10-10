[CmdletBinding()]
param(
    [ValidateRange(1, 10)]
    [int]$Repeat = 2,
    [switch]$RequireFixture,
    [string]$ResultFile = $env:P4DECK_E2E_RESULT_FILE
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
$RequireFixtureRequested = $RequireFixture.IsPresent -or $env:P4DECK_CI_RUN_P4D -eq "1"
$ResultSchemaVersion = 1

function Write-E2EResult {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("passed", "failed", "skipped")]
        [string]$Status,
        [Parameter(Mandatory = $true)]
        [string]$Reason,
        [string[]]$Missing = @(),
        [int]$CompletedRuns = 0
    )

    if ([string]::IsNullOrWhiteSpace($ResultFile)) {
        return
    }

    $resolvedResultFile = [IO.Path]::GetFullPath($ResultFile)
    $resultDirectory = [IO.Path]::GetDirectoryName($resolvedResultFile)
    if (-not [string]::IsNullOrWhiteSpace($resultDirectory)) {
        [IO.Directory]::CreateDirectory($resultDirectory) | Out-Null
    }
    $result = [ordered]@{
        schemaVersion = $ResultSchemaVersion
        suite = "localhost-p4d-e2e"
        status = $Status
        reason = $Reason
        required = $RequireFixtureRequested
        repeat = $Repeat
        completedRuns = $CompletedRuns
        missing = @($Missing)
    }
    $json = $result | ConvertTo-Json -Depth 3 -Compress
    [IO.File]::WriteAllText(
        $resolvedResultFile,
        "$json`n",
        [Text.UTF8Encoding]::new($false)
    )
}

$missingPrerequisites = @()
if (-not (Test-Path -LiteralPath $FixtureScript -PathType Leaf)) {
    $missingPrerequisites += "fixture-script"
}
if (-not (Test-Path -LiteralPath $P4 -PathType Leaf)) {
    $missingPrerequisites += "p4"
}
if (-not (Test-Path -LiteralPath $P4d -PathType Leaf)) {
    $missingPrerequisites += "p4d"
}
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "src-tauri\Cargo.toml") -PathType Leaf)) {
    $missingPrerequisites += "cargo-manifest"
}
if ($null -eq (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $missingPrerequisites += "cargo"
}

if ($missingPrerequisites.Count -gt 0) {
    if ($RequireFixtureRequested) {
        Write-E2EResult -Status "failed" -Reason "fixture-prerequisite-missing" -Missing $missingPrerequisites
        [Console]::Error.WriteLine(
            "FAIL BE-002 localhost E2E: required fixture prerequisites are missing ({0}). Run 'pnpm fixture:setup:win' where appropriate." -f ($missingPrerequisites -join ", ")
        )
        exit 78
    }
    Write-E2EResult -Status "skipped" -Reason "fixture-prerequisite-missing" -Missing $missingPrerequisites
    Write-Warning (
        "SKIP BE-002 localhost E2E: fixture prerequisites are missing ({0}). Run 'pnpm fixture:setup:win'." -f ($missingPrerequisites -join ", ")
    )
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

$wasRunning = Test-FixturePort
$fixtureStartAttempted = $false
$completedRuns = 0
$failureReason = $null
try {
    $fixtureStartAttempted = $true
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $FixtureScript start
    if ($LASTEXITCODE -ne 0) {
        throw "fixture-start-failed"
    }

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
            throw "test-run-failed"
        }
        $completedRuns = $run
    }
}
catch {
    $failureReason = "execution-failed"
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
    if ($fixtureStartAttempted -and -not $wasRunning) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $FixtureScript stop
        if ($LASTEXITCODE -ne 0) {
            $failureReason = "fixture-cleanup-failed"
        }
    }
}

if ($null -ne $failureReason) {
    Write-E2EResult -Status "failed" -Reason $failureReason -CompletedRuns $completedRuns
    [Console]::Error.WriteLine("FAIL BE-002 localhost E2E: $failureReason.")
    exit 1
}

Write-E2EResult -Status "passed" -Reason "completed" -CompletedRuns $completedRuns
