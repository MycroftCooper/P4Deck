@echo off
rem Candidate cargo wrapper: shared Rust build cache, optional sccache.
rem Does not touch the original tree and does not change system settings.
rem Usage: scripts\workflow\cargo-candidate.cmd check --offline --locked --lib
setlocal
set "P4DECK_SHARED=%TEMP%\p4deck-shared"
set "CARGO_TARGET_DIR=%P4DECK_SHARED%\cargo-target"
if not exist "%CARGO_TARGET_DIR%" mkdir "%CARGO_TARGET_DIR%" >nul 2>nul
if exist "%P4DECK_SHARED%\sccache.exe" set "RUSTC_WRAPPER=%P4DECK_SHARED%\sccache.exe"
where sccache >nul 2>nul && set "RUSTC_WRAPPER=sccache"
cargo %*
exit /b %ERRORLEVEL%
