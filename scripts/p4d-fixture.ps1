[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("setup", "start", "status", "stop", "destroy")]
    [string]$Action = "status",

    [ValidateRange(1024, 65535)]
    [int]$Port = 16661
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$FixtureRoot = [IO.Path]::GetFullPath((Join-Path $RepoRoot ".tools\p4d-fixture"))
$BinRoot = Join-Path $FixtureRoot "bin"
$ServerRoot = Join-Path $FixtureRoot "server"
$ClientRoot = Join-Path $FixtureRoot "workspace"
$P4Bin = Join-Path $BinRoot "p4.exe"
$P4dBin = Join-Path $BinRoot "p4d.exe"
$PidFile = Join-Path $FixtureRoot "p4d.pid"
$EnvFile = Join-Path $FixtureRoot "env.ps1"
$LogFile = Join-Path $FixtureRoot "p4d.log"
$JournalFile = Join-Path $FixtureRoot "journal"
$TicketsFile = Join-Path $FixtureRoot "tickets"
$TrustFile = Join-Path $FixtureRoot "trust"
$EnviroFile = Join-Path $FixtureRoot "p4enviro"
$ServerAddress = "127.0.0.1:$Port"
$FixtureUser = "p4deck-fixture-admin"
$FixtureClient = "p4deck-fixture"
$FixtureServerId = "p4deck-fixture-local"
$FixturePassword = "p4deck-local-only"

# Pinned official P4 2026.1 Windows x64 binaries. Hashes come from the
# SHA256SUMS file in the same Perforce release directory.
$ReleaseBaseUrl = "https://ftp.perforce.com/perforce/r26.1/bin.ntx64"
$Downloads = @{
    "p4.exe" = @{
        Url = "$ReleaseBaseUrl/p4.exe"
        Sha256 = "3239328be1ce92e55bd7ca7daf35a0901d696de96fbaa3ad41f334a57389e515"
    }
    "p4d.exe" = @{
        Url = "$ReleaseBaseUrl/p4d.exe"
        Sha256 = "b2d4254c5e5a8fc2b9389504b97de17fcba0e7045146de7ac214d074f1a75e3a"
    }
}

function Assert-PinnedBinary {
    param(
        [Parameter(Mandatory)]
        [string]$Path,
        [Parameter(Mandatory)]
        [string]$ExpectedSha256
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing fixture binary: $Path"
    }

    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $hashBytes = $sha256.ComputeHash($stream)
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
    $actual = ([BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    if ($actual -ne $ExpectedSha256) {
        throw "SHA-256 mismatch for $Path. Expected $ExpectedSha256, got $actual."
    }
}

function Install-PinnedBinary {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    $metadata = $Downloads[$Name]
    $target = Join-Path $BinRoot $Name
    if (Test-Path -LiteralPath $target -PathType Leaf) {
        Assert-PinnedBinary -Path $target -ExpectedSha256 $metadata.Sha256
        Write-Host "$Name already present and verified."
        return
    }

    New-Item -ItemType Directory -Path $BinRoot -Force | Out-Null
    $temporary = "$target.download"
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue

    try {
        Write-Host "Downloading $Name from Perforce over HTTPS..."
        Invoke-WebRequest -UseBasicParsing -Uri $metadata.Url -OutFile $temporary
        Assert-PinnedBinary -Path $temporary -ExpectedSha256 $metadata.Sha256

        try {
            $signature = Get-AuthenticodeSignature -LiteralPath $temporary -ErrorAction Stop
            $signatureStatus = $signature.Status.ToString()
            $signatureSubject = $signature.SignerCertificate.Subject
        }
        catch {
            # Some Windows images have a broken Windows PowerShell Security module.
            # Fall back to PowerShell 7 when it is available, without weakening the check.
            $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
            if ($null -eq $pwsh) {
                throw "Authenticode verification is unavailable in this PowerShell host."
            }
            $previousSignatureTarget = $env:P4DECK_SIGNATURE_TARGET
            try {
                $env:P4DECK_SIGNATURE_TARGET = $temporary
                $signatureCommand = '$value = Get-AuthenticodeSignature -LiteralPath $env:P4DECK_SIGNATURE_TARGET; Write-Output ($value.Status.ToString() + [char]124 + $value.SignerCertificate.Subject)'
                $signatureResult = & $pwsh.Source -NoProfile -Command $signatureCommand
            }
            finally {
                if ($null -eq $previousSignatureTarget) {
                    Remove-Item -LiteralPath Env:P4DECK_SIGNATURE_TARGET -ErrorAction SilentlyContinue
                }
                else {
                    $env:P4DECK_SIGNATURE_TARGET = $previousSignatureTarget
                }
            }
            if ($LASTEXITCODE -ne 0 -or $signatureResult -notmatch '^([^|]+)\|(.*)$') {
                throw "Authenticode verification failed for $Name."
            }
            $signatureStatus = $Matches[1]
            $signatureSubject = $Matches[2]
        }
        if ($signatureStatus -ne "Valid") {
            throw "Authenticode signature for $Name is not valid: $signatureStatus."
        }
        if ($signatureSubject -notmatch "Perforce") {
            throw "Unexpected Authenticode signer for ${Name}: $signatureSubject"
        }

        Move-Item -LiteralPath $temporary -Destination $target
        Write-Host "$Name downloaded and verified."
    }
    catch {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Assert-FixtureTools {
    foreach ($name in @("p4.exe", "p4d.exe")) {
        $metadata = $Downloads[$name]
        Assert-PinnedBinary -Path (Join-Path $BinRoot $name) -ExpectedSha256 $metadata.Sha256
    }
}

function Invoke-WithFixtureEnvironment {
    param(
        [Parameter(Mandatory)]
        [scriptblock]$ScriptBlock
    )

    $names = @(
        "P4PORT", "P4USER", "P4CLIENT", "P4CHARSET", "P4CONFIG",
        "P4TICKETS", "P4TRUST", "P4ENVIRO", "P4PASSWD"
    )
    $previous = @{}

    foreach ($name in $names) {
        $item = Get-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
        $previous[$name] = if ($null -eq $item) { $null } else { $item.Value }
    }

    try {
        $env:P4PORT = $ServerAddress
        $env:P4USER = $FixtureUser
        $env:P4CLIENT = $FixtureClient
        $env:P4CHARSET = "none"
        $env:P4TICKETS = $TicketsFile
        $env:P4TRUST = $TrustFile
        $env:P4ENVIRO = $EnviroFile
        Remove-Item -LiteralPath Env:P4CONFIG -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath Env:P4PASSWD -ErrorAction SilentlyContinue
        & $ScriptBlock
    }
    finally {
        foreach ($name in $names) {
            if ($null -eq $previous[$name]) {
                Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
            }
            else {
                Set-Item -LiteralPath "Env:$name" -Value $previous[$name]
            }
        }
    }
}

function Invoke-FixtureP4 {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [AllowNull()]
        [string]$InputText = $null,
        [switch]$AllowFailure
    )

    $result = Invoke-WithFixtureEnvironment {
        $allArguments = @("-p", $ServerAddress, "-u", $FixtureUser, "-c", $FixtureClient) + $Arguments
        $quotedArguments = $allArguments | ForEach-Object {
            if ($_ -match '[\s"]') {
                '"' + $_.Replace('"', '\"') + '"'
            }
            else {
                $_
            }
        }

        $ioRoot = Join-Path $FixtureRoot "io"
        New-Item -ItemType Directory -Path $ioRoot -Force | Out-Null
        $token = [guid]::NewGuid().ToString("N")
        $inputPath = Join-Path $ioRoot "$token.in"
        $stdoutPath = Join-Path $ioRoot "$token.out"
        $stderrPath = Join-Path $ioRoot "$token.err"
        try {
            $startParameters = @{
                FilePath = $P4Bin
                ArgumentList = ($quotedArguments -join " ")
                PassThru = $true
                Wait = $true
                WindowStyle = "Hidden"
                RedirectStandardOutput = $stdoutPath
                RedirectStandardError = $stderrPath
            }
            if ($null -ne $InputText) {
                $inputWithoutBom = $InputText.TrimStart([char]0xFEFF)
                $inputValue = if ($inputWithoutBom.EndsWith("`n")) { $inputWithoutBom } else { $inputWithoutBom + "`n" }
                [IO.File]::WriteAllText($inputPath, $inputValue, [Text.UTF8Encoding]::new($false))
                $startParameters.RedirectStandardInput = $inputPath
            }
            $process = Start-Process @startParameters
            $stdout = if (Test-Path -LiteralPath $stdoutPath) { [IO.File]::ReadAllText($stdoutPath) } else { "" }
            $stderr = if (Test-Path -LiteralPath $stderrPath) { [IO.File]::ReadAllText($stderrPath) } else { "" }
            $nativeOutput = @($stdout, $stderr) |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
                ForEach-Object { $_ -split "`r?`n" }
            $nativeExitCode = $process.ExitCode
        }
        finally {
            Remove-Item -LiteralPath $inputPath, $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
        }

        [pscustomobject]@{
            ExitCode = $nativeExitCode
            Output = @($nativeOutput | ForEach-Object { $_.ToString() })
        }
    }

    if (-not $AllowFailure -and $result.ExitCode -ne 0) {
        throw "p4 $($Arguments -join ' ') failed with exit code $($result.ExitCode): $($result.Output -join [Environment]::NewLine)"
    }

    return $result
}

function Get-FixtureServerId {
    $result = Invoke-FixtureP4 -Arguments @("-ztag", "info") -AllowFailure
    if ($result.ExitCode -ne 0) {
        return $null
    }

    foreach ($line in $result.Output) {
        if ($line -match '^\.\.\. serverID (.+)$') {
            return $Matches[1].Trim()
        }
    }
    return $null
}

function Test-PortOpen {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync("127.0.0.1", $Port)
        return $task.Wait(300) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Assert-RunningServerIsFixture {
    $reportedServerId = Get-FixtureServerId
    if ($reportedServerId -ne $FixtureServerId) {
        throw "Port $Port is in use by a server that is not this fixture. Nothing was changed."
    }
}

function Initialize-FixtureServerId {
    $serverIdFile = Join-Path $ServerRoot "server.id"
    if (Test-Path -LiteralPath $serverIdFile -PathType Leaf) {
        $existing = (Get-Content -LiteralPath $serverIdFile -Raw).Trim()
        if ($existing -ne $FixtureServerId) {
            throw "Unexpected Server ID in fixture root: $existing"
        }
        return
    }

    $output = & $P4dBin -r $ServerRoot -xD $FixtureServerId 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Could not initialize fixture Server ID: $($output -join [Environment]::NewLine)"
    }
    $written = (Get-Content -LiteralPath $serverIdFile -Raw).Trim()
    if ($written -ne $FixtureServerId) {
        throw "Fixture Server ID verification failed."
    }
}

function Initialize-FixtureLogin {
    $status = Invoke-FixtureP4 -Arguments @("login", "-s") -AllowFailure
    if ($status.ExitCode -eq 0) {
        return
    }

    $login = Invoke-FixtureP4 -Arguments @("login") -InputText $FixturePassword -AllowFailure
    if ($login.ExitCode -eq 0) {
        return
    }

    $passwordInput = "$FixturePassword`n$FixturePassword"
    $password = Invoke-FixtureP4 -Arguments @("passwd") -InputText $passwordInput -AllowFailure
    if ($password.ExitCode -ne 0) {
        throw "Could not initialize the fixture-only password: $($password.Output -join [Environment]::NewLine)"
    }

    $login = Invoke-FixtureP4 -Arguments @("login") -InputText $FixturePassword -AllowFailure
    if ($login.ExitCode -ne 0) {
        throw "Could not create the fixture-only login ticket: $($login.Output -join [Environment]::NewLine)"
    }
}

function Write-FixtureEnvironmentFile {
    $escapedP4 = $P4Bin.Replace("'", "''")
    $escapedTickets = $TicketsFile.Replace("'", "''")
    $escapedTrust = $TrustFile.Replace("'", "''")
    $escapedEnviro = $EnviroFile.Replace("'", "''")
    $content = @"
# Generated by scripts/p4d-fixture.ps1. Applies only to the current PowerShell session.
`$env:P4PORT = '$ServerAddress'
`$env:P4USER = '$FixtureUser'
`$env:P4CLIENT = '$FixtureClient'
`$env:P4CHARSET = 'none'
`$env:P4TICKETS = '$escapedTickets'
`$env:P4TRUST = '$escapedTrust'
`$env:P4ENVIRO = '$escapedEnviro'
`$env:P4_PATH = '$escapedP4'
Remove-Item -LiteralPath Env:P4CONFIG -ErrorAction SilentlyContinue
"@
    Set-Content -LiteralPath $EnvFile -Value $content -Encoding utf8
}

function Initialize-FixtureData {
    Initialize-FixtureLogin
    New-Item -ItemType Directory -Path $ClientRoot -Force | Out-Null
    $clientRootForSpec = $ClientRoot.Replace("\", "/")
    $clientSpec = @"
Client: $FixtureClient
Owner: $FixtureUser
Root: $clientRootForSpec
Options: noallwrite noclobber nocompress unlocked nomodtime normdir
LineEnd: local
View:
`t//depot/... //$FixtureClient/...
"@
    Invoke-FixtureP4 -Arguments @("client", "-i") -InputText $clientSpec | Out-Null

    $readmeDirectory = Join-Path $ClientRoot "main"
    $readmePath = Join-Path $readmeDirectory "README.txt"
    New-Item -ItemType Directory -Path $readmeDirectory -Force | Out-Null

    $submitted = Invoke-FixtureP4 -Arguments @("-ztag", "changes", "-m", "1", "//depot/...")
    if (-not ($submitted.Output -match '^\.\.\. change ')) {
        [IO.File]::WriteAllText($readmePath, "P4Deck fixture`n", [Text.UTF8Encoding]::new($false))
        Invoke-FixtureP4 -Arguments @("add", $readmePath) | Out-Null
        Invoke-FixtureP4 -Arguments @("submit", "-d", "Seed normal changelist") | Out-Null
    }

    $shelved = Invoke-FixtureP4 -Arguments @("-ztag", "changes", "-s", "shelved", "-m", "1", "//depot/...")
    if (-not ($shelved.Output -match '^\.\.\. change ')) {
        Invoke-FixtureP4 -Arguments @("sync", "-f", $readmePath) | Out-Null
        Invoke-FixtureP4 -Arguments @("edit", $readmePath) | Out-Null
        [IO.File]::AppendAllText($readmePath, "pending`n", [Text.UTF8Encoding]::new($false))

        $changeSpec = @"
Change: new
Client: $FixtureClient
User: $FixtureUser
Description:
`tFixture shelf
"@
        $created = Invoke-FixtureP4 -Arguments @("change", "-i") -InputText $changeSpec
        $changeText = $created.Output -join "`n"
        if ($changeText -notmatch 'Change\s+(\d+)\s+created') {
            throw "Could not parse fixture changelist number: $changeText"
        }
        $changeNumber = $Matches[1]
        Invoke-FixtureP4 -Arguments @("reopen", "-c", $changeNumber, $readmePath) | Out-Null
        Invoke-FixtureP4 -Arguments @("shelve", "-c", $changeNumber) | Out-Null
    }

    Write-FixtureEnvironmentFile
}

function Start-Fixture {
    Assert-FixtureTools
    New-Item -ItemType Directory -Path $ServerRoot, $ClientRoot -Force | Out-Null
    Initialize-FixtureServerId

    if (Test-PortOpen) {
        Assert-RunningServerIsFixture
        Write-Host "Fixture already running at $ServerAddress."
        Write-FixtureEnvironmentFile
        return
    }

    $argumentLine = @(
        '-r', ('"{0}"' -f $ServerRoot),
        '-p', $ServerAddress,
        '-L', ('"{0}"' -f $LogFile),
        '-J', ('"{0}"' -f $JournalFile)
    ) -join ' '

    $process = Start-Process -FilePath $P4dBin -ArgumentList $argumentLine -PassThru -WindowStyle Hidden
    Set-Content -LiteralPath $PidFile -Value $process.Id -Encoding ascii

    try {
        $ready = $false
        for ($attempt = 0; $attempt -lt 100; $attempt++) {
            Start-Sleep -Milliseconds 100
            if (Test-PortOpen) {
                $reportedServerId = Get-FixtureServerId
                if ($reportedServerId -eq $FixtureServerId) {
                    $ready = $true
                    break
                }
            }
        }

        if (-not $ready) {
            throw "Fixture server did not become ready. See $LogFile"
        }

        Initialize-FixtureData
        Write-Host "Fixture started and seeded at $ServerAddress."
        Write-Host "For an isolated shell: . '$EnvFile'"
    }
    catch {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Stop-Fixture {
    if (-not (Test-PortOpen)) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        Write-Host "Fixture is not running."
        return
    }

    Assert-FixtureTools
    Assert-RunningServerIsFixture
    Initialize-FixtureLogin
    $result = Invoke-FixtureP4 -Arguments @("admin", "stop") -AllowFailure
    if ($result.ExitCode -ne 0) {
        throw "Could not stop fixture cleanly: $($result.Output -join [Environment]::NewLine)"
    }

    for ($attempt = 0; $attempt -lt 50 -and (Test-PortOpen); $attempt++) {
        Start-Sleep -Milliseconds 100
    }
    if (Test-PortOpen) {
        throw "Fixture still listens on $ServerAddress after p4 admin stop."
    }

    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    Write-Host "Fixture stopped. Data remains in $FixtureRoot."
}

function Show-FixtureStatus {
    $toolsReady = $true
    try {
        Assert-FixtureTools
    }
    catch {
        $toolsReady = $false
    }

    $state = if (Test-PortOpen) {
        if ($toolsReady) {
            try {
                Assert-RunningServerIsFixture
                "running"
            }
            catch {
                "port occupied by another process"
            }
        }
        else {
            "port occupied; fixture tools unavailable"
        }
    }
    else {
        "stopped"
    }

    Write-Host "Fixture root : $FixtureRoot"
    Write-Host "Server       : $ServerAddress ($state)"
    Write-Host "Pinned tools : $(if ($toolsReady) { 'verified' } else { 'not installed' })"
    Write-Host "Windows svc  : not used"
    Write-Host "System PATH  : not modified"
}

switch ($Action) {
    "setup" {
        Install-PinnedBinary -Name "p4.exe"
        Install-PinnedBinary -Name "p4d.exe"
        Assert-FixtureTools
        Write-Host "Pinned P4 fixture tools are ready in $BinRoot."
    }
    "start" {
        Start-Fixture
    }
    "status" {
        Show-FixtureStatus
    }
    "stop" {
        Stop-Fixture
    }
    "destroy" {
        Stop-Fixture
        $expected = [IO.Path]::GetFullPath((Join-Path $RepoRoot ".tools\p4d-fixture"))
        if ($FixtureRoot -ne $expected -or -not $FixtureRoot.StartsWith($RepoRoot + [IO.Path]::DirectorySeparatorChar)) {
            throw "Refusing to remove unexpected fixture directory: $FixtureRoot"
        }
        Remove-Item -LiteralPath $FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "Fixture destroyed: $FixtureRoot"
    }
}
