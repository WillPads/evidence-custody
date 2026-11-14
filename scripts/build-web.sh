#!/usr/bin/env sh
# Same as build-web.ps1, for macOS / Linux / Git Bash.
set -e
cd "$(dirname "$0")/.."
cargo build -p custody-web --target wasm32-unknown-unknown --release
wasm-bindgen target/wasm32-unknown-unknown/release/custody_web.wasm --out-dir web/pkg --target web --no-typescript
echo "Built web/pkg"
