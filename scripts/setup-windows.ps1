param(
  [switch]$Check,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$NodeVersion = "24.16.0"
$PnpmVersion = "11.19.0"
$P4Release = "r26.1"
$ToolRoot = Join-Path $env:LOCALAPPDATA "P4Deck\toolchains"
$BinRoot = Join-Path $env:LOCALAPPDATA "P4Deck\bin"
$NodeRoot = Join-Path $ToolRoot "node-v$NodeVersion-win-x64"
$Missing = 0
$Incompatible = 0
$PathChanged = $false

function Confirm-Install([string]$Label) {
  if ($Check) { return $false }
  if ($Yes) { return $true }
  $answer = Read-Host "缺少 $Label，是否安装？[y/N]"
  return $answer -eq "y" -or $answer -eq "Y"
}

function Add-UserPathOnce([string]$PathEntry) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($current -split ";" | Where-Object { $_ })
  if ($parts -contains $PathEntry) { return }
  if ($Check) { Write-Host "WARN 需要把 $PathEntry 加入用户 PATH（-Check 未修改）"; return }
  [Environment]::SetEnvironmentVariable("Path", (($parts + $PathEntry) -join ";"), "User")
  $script:PathChanged = $true
}

function Get-ShaEntry([string]$Text, [string]$Name) {
  foreach ($line in ($Text -split "`n")) {
    if ($line -match "^([a-fA-F0-9]{64})\s+\.?/?$([regex]::Escape($Name))\s*$") { return $Matches[1].ToLower() }
  }
  return $null
}

function Download-Verified([string]$Url, [string]$ChecksumUrl, [string]$Name, [string]$Output) {
  Invoke-WebRequest -Uri $Url -OutFile $Output
  $checksumText = (Invoke-WebRequest -Uri $ChecksumUrl).Content
  $expected = Get-ShaEntry $checksumText $Name
  $actual = (Get-FileHash -Algorithm SHA256 $Output).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { throw "$Name 的 SHA-256 校验失败" }
  Write-Host "OK  SHA-256 已验证：$Name"
}

Write-Host "P4Deck Windows 环境检查"

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $nodeVersion = (& node --version).Trim()
  if ($nodeVersion -match "^v24\.") { Write-Host "OK  Node.js $nodeVersion（兼容）" }
  else { Write-Host "ERR Node.js $nodeVersion；项目要求 24.x，不会覆盖"; $Incompatible++ }
} elseif (Test-Path (Join-Path $NodeRoot "node.exe")) {
  Write-Host "OK  Node.js v$NodeVersion 已在用户目录，等待 PATH 生效"
  Add-UserPathOnce $NodeRoot
  $env:Path = "$NodeRoot;$env:Path"
} else {
  Write-Host "ERR 缺少 Node.js $NodeVersion"; $Missing++
  if (Confirm-Install "Node.js $NodeVersion") {
    New-Item -ItemType Directory -Force $ToolRoot | Out-Null
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("p4deck-node-" + [guid]::NewGuid())
    New-Item -ItemType Directory $temp | Out-Null
    $archive = "node-v$NodeVersion-win-x64.zip"
    Download-Verified "https://nodejs.org/dist/v$NodeVersion/$archive" "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" $archive (Join-Path $temp $archive)
    Expand-Archive (Join-Path $temp $archive) -DestinationPath $ToolRoot
    Add-UserPathOnce $NodeRoot
    $env:Path = "$NodeRoot;$env:Path"
  }
}

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpm) {
  $version = (& pnpm --version).Trim()
  if ($version -eq $PnpmVersion) { Write-Host "OK  pnpm $version" }
  else { Write-Host "ERR pnpm $version；项目固定为 $PnpmVersion，不会覆盖"; $Incompatible++ }
} else {
  Write-Host "ERR 缺少 pnpm $PnpmVersion"; $Missing++
  if ((Get-Command corepack -ErrorAction SilentlyContinue) -and (Confirm-Install "pnpm $PnpmVersion")) {
    & corepack prepare "pnpm@$PnpmVersion" --activate
  }
}

$rustc = Get-Command rustc -ErrorAction SilentlyContinue
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($rustc -and $cargo) {
  Write-Host "OK  $(& rustc --version)"
  if ((Get-Command rustup -ErrorAction SilentlyContinue) -and -not $Check) { & rustup component add rustfmt clippy }
} else {
  Write-Host "ERR 缺少 Rust/Cargo"; $Missing++
  if (Confirm-Install "Rust 1.97.1、Cargo、rustfmt 和 clippy") {
    $tempExe = Join-Path ([IO.Path]::GetTempPath()) "rustup-init.exe"
    Invoke-WebRequest "https://win.rustup.rs/x86_64" -OutFile $tempExe
    & $tempExe -y --profile default --default-toolchain 1.97.1 --default-host x86_64-pc-windows-msvc --no-modify-path
    Add-UserPathOnce (Join-Path $env:USERPROFILE ".cargo\bin")
  }
}

$p4 = Get-Command p4 -ErrorAction SilentlyContinue
if ($p4) {
  $revision = (& p4 -V 2>&1 | Select-String "^Rev\." | Select-Object -First 1).Line
  $supported = $revision -match "/(?<year>[0-9]{4})\.(?<minor>[0-9]+)/" -and
    (([int]$Matches.year -gt 2023) -or (([int]$Matches.year -eq 2023) -and ([int]$Matches.minor -ge 1)))
  if ($supported) { Write-Host "OK  P4 CLI $revision" }
  else { Write-Host "ERR P4 CLI 版本过旧或无法识别：$revision；不会覆盖"; $Incompatible++ }
} elseif (Test-Path (Join-Path $BinRoot "p4.exe")) {
  Write-Host "OK  P4 CLI 已在用户目录，等待 PATH 生效"
  Add-UserPathOnce $BinRoot
} else {
  Write-Host "ERR 缺少 P4 CLI"; $Missing++
  if (Confirm-Install "P4 CLI $P4Release") {
    New-Item -ItemType Directory -Force $BinRoot | Out-Null
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("p4deck-p4-" + [guid]::NewGuid())
    New-Item -ItemType Directory $temp | Out-Null
    $base = "https://ftp.perforce.com/perforce/$P4Release/bin.ntx64"
    Download-Verified "$base/p4.exe" "$base/SHA256SUMS" "p4.exe" (Join-Path $temp "p4.exe")
    Copy-Item (Join-Path $temp "p4.exe") (Join-Path $BinRoot "p4.exe")
    Add-UserPathOnce $BinRoot
  }
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVCTools = $false
if (Test-Path $vswhere) {
  $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  $hasVCTools = -not [string]::IsNullOrWhiteSpace($installation)
}
if ($hasVCTools) { Write-Host "OK  Visual Studio C++ Build Tools" }
else {
  Write-Host "ERR 缺少 Visual Studio C++ Build Tools"; $Missing++
  if (Confirm-Install "Visual Studio 2022 C++ Build Tools") {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "缺少 winget，请手工安装 Visual Studio Build Tools" }
    & winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" --accept-package-agreements --accept-source-agreements
  }
}

$webView2 = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*" -ErrorAction SilentlyContinue |
  Where-Object { $_.name -like "*WebView2*" } | Select-Object -First 1
if ($webView2) { Write-Host "OK  Microsoft Edge WebView2 Runtime $($webView2.pv)" }
else {
  Write-Host "ERR 缺少 Microsoft Edge WebView2 Runtime"; $Missing++
  if (Confirm-Install "Microsoft Edge WebView2 Runtime") {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { throw "缺少 winget，请手工安装 WebView2 Runtime" }
    & winget install --id Microsoft.EdgeWebView2Runtime --exact --accept-package-agreements --accept-source-agreements
  }
}

Write-Host "`n检查结果：缺失 $Missing 项，不兼容 $Incompatible 项。"
if ($Incompatible -gt 0) { throw "请先决定如何处理不兼容版本；脚本未修改它们。" }
if ($Check -and $Missing -gt 0) { exit 1 }
if ($PathChanged) { Write-Host "用户 PATH 已追加缺失路径。请打开新 PowerShell 后运行 .\scripts\doctor.ps1。" }
Write-Host "初始化完成。再次运行不会重复安装兼容组件。"
