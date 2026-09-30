param(
  [switch]$FrontendOnly
)

$failures = 0
$warnings = 0

if (Get-Command node -ErrorAction SilentlyContinue) {
  $version = (& node --version).Trim()
  if ($version -match "^v24\.") { Write-Host "OK   Node.js $version" } else { Write-Host "ERR  Node.js $version（需要 24.x）"; $failures++ }
} else { Write-Host "ERR  Node.js missing"; $failures++ }

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  $version = (& pnpm --version).Trim()
  if ($version -eq "11.19.0") { Write-Host "OK   pnpm $version" } else { Write-Host "ERR  pnpm $version（需要 11.19.0）"; $failures++ }
} else { Write-Host "ERR  pnpm missing"; $failures++ }

if (-not $FrontendOnly) {
  if (Get-Command rustup -ErrorAction SilentlyContinue) {
    $toolchains = & rustup toolchain list
    if ($toolchains -match "(?m)^1\.97\.1(-|\s)") { Write-Host "OK   Rust Toolchain 1.97.1" } else { Write-Host "ERR  缺少 Rust Toolchain 1.97.1"; $failures++ }
  } else { Write-Host "ERR  rustup missing"; $failures++ }

  if (Get-Command cargo -ErrorAction SilentlyContinue) { Write-Host "OK   $(& cargo --version)" } else { Write-Host "ERR  Cargo missing"; $failures++ }
}

if (Get-Command p4 -ErrorAction SilentlyContinue) {
  $revision = (& p4 -V 2>&1 | Select-String "^Rev\." | Select-Object -First 1).Line
  $supported = $revision -match "/(?<year>[0-9]{4})\.(?<minor>[0-9]+)/" -and
    (([int]$Matches.year -gt 2023) -or (([int]$Matches.year -eq 2023) -and ([int]$Matches.minor -ge 1)))
  if ($supported) { Write-Host "OK   P4 CLI $revision" } else { Write-Host "ERR  P4 CLI 需要 2023.1+：$revision"; $failures++ }
} else { Write-Host "WARN P4 CLI missing；仅 UI 开发可继续"; $warnings++ }

if (-not $FrontendOnly) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $hasVCTools = $false
  if (Test-Path $vswhere) {
    $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    $hasVCTools = -not [string]::IsNullOrWhiteSpace($installation)
  }
  if ($hasVCTools) { Write-Host "OK   Visual Studio C++ Build Tools" } else { Write-Host "ERR  Visual Studio C++ Build Tools missing"; $failures++ }

  $webView2 = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.name -like "*WebView2*" } | Select-Object -First 1
  if ($webView2) { Write-Host "OK   Microsoft Edge WebView2 Runtime $($webView2.pv)" } else { Write-Host "ERR  Microsoft Edge WebView2 Runtime missing"; $failures++ }
}

Write-Host "`n检查完成：$failures 个错误，$warnings 个警告。"
if ($failures -gt 0) { Write-Host "参见 ForAIDoc/Coder/开发环境.md。"; exit 1 }
if ($FrontendOnly) { Write-Host "前端 Mock 开发环境已就绪；Tauri 桌面开发仍需 Rust 和 C++ Build Tools。" }
else { Write-Host "桌面开发环境已就绪。" }
