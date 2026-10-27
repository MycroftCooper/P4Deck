# Pure tests: parse selected function definitions, never dot-source the fixture
# entry point. All OS, environment, registry and binary checks below are fakes.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$fixturePath = Join-Path $PSScriptRoot "p4d-fixture.ps1"
$parseErrors = $null
$tokens = $null
$fixtureAst = [Management.Automation.Language.Parser]::ParseFile($fixturePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "Fixture syntax errors" }
$names = @("Test-PortOpen", "Assert-NoAmbientP4Configuration", "Invoke-FixtureP4", "Start-Fixture")
foreach ($name in $names) {
    $definition = $fixtureAst.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst]
    }, $false) | Where-Object Name -EQ $name
    if (@($definition).Count -ne 1) { throw "Missing or ambiguous function: $name" }
    . ([scriptblock]::Create($definition.Extent.Text))
}

$Port = 16661
$ServerAddress = "127.0.0.1:16661"
$P4dBin = 'C:\fixture space\bin\p4d.exe'
$ServerRoot = 'C:\fixture space\server'
$LogFile = 'C:\fixture space\p4d.log'
$JournalFile = 'C:\fixture space\journal'
$EnviroFile = 'C:\fixture space\p4enviro'
$expectedCommand = '"{0}" -r "{1}" -p {2} -L "{3}" -J "{4}"' -f $P4dBin, $ServerRoot, $ServerAddress, $LogFile, $JournalFile

function Reset-Fakes {
    $script:listeners = @([pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 16661; OwningProcess = 42 })
    $script:owners = @([pscustomobject]@{ ExecutablePath = $P4dBin; CommandLine = $expectedCommand })
    $script:denyListener = $false
    $script:denyOwner = $false
    $script:denyRegistry = $false
    $script:badBinary = $false
    $script:ambientNames = @()
    $script:registryNames = @()
    $script:enviroLength = 0
    $script:effectCalls = 0
}
function Get-NetTCPConnection { param($State, $ErrorAction)
    if ($script:denyListener) { throw 'Fake CIM denial' }
    $script:listeners
}
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction)
    if ($script:denyOwner) { throw 'Fake process metadata denial' }
    if ($Filter -ne 'ProcessId = 42') { throw 'Unexpected owner query' }
    $script:owners
}
function Assert-FixtureTools {
    if ($script:badBinary) { throw 'Fake hash mismatch' }
}
function Get-ChildItem { param($Path)
    if ($Path -ne 'Env:') { throw 'Unexpected enumeration' }
    $script:ambientNames | ForEach-Object { [pscustomobject]@{ Name = $_ } }
}
function Test-Path { param($LiteralPath, $ErrorAction)
    if ($LiteralPath -eq $EnviroFile) { return $script:enviroLength -gt 0 }
    if ($LiteralPath -notlike 'HK*:\Software\Perforce\Environment') { throw 'Unexpected path check' }
    if ($script:denyRegistry) { throw 'Fake registry denial' }
    return $script:registryNames.Count -gt 0
}
function Get-Item { param($LiteralPath, $ErrorAction)
    if ($LiteralPath -eq $EnviroFile) { return [pscustomobject]@{ Length = $script:enviroLength } }
    $value = [pscustomobject]@{}
    $value | Add-Member ScriptMethod GetValueNames { $script:registryNames }
    return $value
}
function Invoke-WithFixtureEnvironment { param($ScriptBlock)
    $script:effectCalls++
    throw 'A P4 launch boundary was reached'
}
function New-Item { $script:effectCalls++; throw 'A filesystem mutation was reached' }
function Initialize-FixtureServerId { $script:effectCalls++; throw 'A P4D launch boundary was reached' }
function Start-Process { $script:effectCalls++; throw 'A process launch was reached' }
function Assert-Blocked { param([scriptblock]$Action)
    $blocked = $false
    try { & $Action | Out-Null } catch { $blocked = $true }
    if (-not $blocked) { throw 'Expected fail-closed rejection' }
    if ($script:effectCalls -ne 0) { throw 'Rejected input reached a side effect' }
}
function Assert-True { param($Value)
    if ($Value -ne $true) { throw 'Expected true' }
}
$cases = [ordered]@{
    'verified owner with exact fixture arguments' = { Assert-True (Test-PortOpen) }
    'empty listener inventory is stopped' = { $script:listeners = @(); Assert-True (-not (Test-PortOpen)) }
    'CIM denial propagates before P4' = { $script:denyListener = $true; Assert-Blocked { Invoke-FixtureP4 -Arguments @('info') } }
    'CIM denial stops startup before files or P4D' = { $script:denyListener = $true; Assert-Blocked { Start-Fixture } }
    'unknown owner blocks startup' = { $script:owners[0].ExecutablePath = 'C:\other\p4d.exe'; Assert-Blocked { Start-Fixture } }
    'wildcard listener rejected' = { $script:listeners[0].LocalAddress = '0.0.0.0'; Assert-Blocked { Test-PortOpen } }
    'multiple listeners rejected' = { $script:listeners += $script:listeners[0]; Assert-Blocked { Test-PortOpen } }
    'missing process metadata rejected' = { $script:owners = @(); Assert-Blocked { Test-PortOpen } }
    'denied process metadata rejected' = { $script:denyOwner = $true; Assert-Blocked { Test-PortOpen } }
    'missing command line rejected' = { $script:owners[0].CommandLine = $null; Assert-Blocked { Test-PortOpen } }
    'different server root rejected' = { $script:owners[0].CommandLine = $expectedCommand.Replace($ServerRoot, 'C:\other'); Assert-Blocked { Test-PortOpen } }
    'extra forwarding arguments rejected' = { $script:owners[0].CommandLine += ' -t example.invalid:1666'; Assert-Blocked { Test-PortOpen } }
    'binary hash failure rejects P4 call' = { $script:badBinary = $true; Assert-Blocked { Invoke-FixtureP4 -Arguments @('info') } }
    'no listener rejects P4 call' = { $script:listeners = @(); Assert-Blocked { Invoke-FixtureP4 -Arguments @('info') } }
    'ambient configuration blocks startup' = { $script:ambientNames = @('P4CONFIG'); Assert-Blocked { Start-Fixture } }
    'ambient credential blocks P4' = { $script:ambientNames = @('P4PASSWD'); Assert-Blocked { Invoke-FixtureP4 -Arguments @('info') } }
    'registry configuration rejected' = { $script:registryNames = @('P4CONFIG'); Assert-Blocked { Assert-NoAmbientP4Configuration } }
    'registry credential rejected' = { $script:registryNames = @('P4PASSWD'); Assert-Blocked { Assert-NoAmbientP4Configuration } }
    'registry denial rejected' = { $script:denyRegistry = $true; Assert-Blocked { Assert-NoAmbientP4Configuration } }
    'nonempty enviro rejected' = { $script:enviroLength = 1; Assert-Blocked { Assert-NoAmbientP4Configuration } }
    'test metadata and installation path allowed' = { $script:ambientNames = @('P4DECK_E2E'); $script:registryNames = @('P4INSTROOT'); Assert-NoAmbientP4Configuration }
}
foreach ($case in $cases.GetEnumerator()) {
    Reset-Fakes
    & $case.Value
    Write-Output "PASS $($case.Key)"
}

# The E2E wrapper must also use passive OS inventory before fixture startup.
$wrapperErrors = $null
$wrapperAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'test-p4d-e2e.ps1'), [ref]$tokens, [ref]$wrapperErrors)
if ($wrapperErrors.Count) { throw 'E2E wrapper syntax errors' }
$wrapperFunction = $wrapperAst.FindAll({ param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-FixturePort'
}, $false)
. ([scriptblock]::Create($wrapperFunction[0].Extent.Text))
Reset-Fakes
$script:denyListener = $true
Assert-Blocked { Test-FixturePort }
Write-Output 'PASS wrapper propagates CIM denial'
Reset-Fakes
Assert-True (Test-FixturePort)
$script:listeners = @()
Assert-True (-not (Test-FixturePort))
Write-Output 'PASS wrapper distinguishes present and absent listeners'
Write-Output "$($cases.Count + 2) pure tests passed; no P4, network, registry or process inspection executed."
