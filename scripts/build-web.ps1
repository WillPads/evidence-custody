# Compiles the Rust core to WebAssembly and puts it in web/pkg, ready for Vercel.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File scripts\build-web.ps1
#
# One-time setup:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.130 --locked
#   (the CLI version must match the wasm-bindgen version in Cargo.lock)

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

cargo build -p custody-web --target wasm32-unknown-unknown --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

wasm-bindgen target/wasm32-unknown-unknown/release/custody_web.wasm --out-dir web/pkg --target web --no-typescript
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$size = (Get-Item web/pkg/custody_web_bg.wasm).Length / 1KB
Write-Host ("Built web/pkg (wasm: {0:N0} KB)" -f $size)
