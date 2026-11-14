# Guided demo of the `custody` command-line tool.
# Run in VS Code: Terminal > Run Task... > "Demo: command-line tool"
# Or:            powershell -ExecutionPolicy Bypass -File scripts\demo.ps1
#
# It builds the tool, creates a fresh demo/ folder with sample evidence,
# logs and transfers evidence, then tampers with things and shows that
# `custody verify` catches each attack. Press Enter to move between steps.
# (Use -NoPause to run straight through.)

param([switch]$NoPause)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # so check marks display correctly
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"         # find cargo even if VS Code was open during the Rust install
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$exe = Join-Path $root "target\release\custody.exe"
$demo = Join-Path $root "demo"

function Step($title) {
    Write-Host ""
    Write-Host ("=" * 70) -ForegroundColor DarkGray
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host ("=" * 70) -ForegroundColor DarkGray
}

function Pause-Demo {
    if (-not $NoPause) { Read-Host "`n  Press Enter to continue" | Out-Null }
}

# Show the command, then run it (like typing it live).
function Run {
    Write-Host ""
    $shown = $args | ForEach-Object { if ("$_" -match "\s") { "`"$_`"" } else { "$_" } }
    Write-Host ("  > custody " + ($shown -join " ")) -ForegroundColor Yellow
    & $exe @args
}

Step "Building the custody tool (Rust, release mode)"
Push-Location $root
cargo build --release -p custody-cli --quiet
if ($LASTEXITCODE -ne 0) { Pop-Location; exit 1 }
Pop-Location
Write-Host "  Built $exe" -ForegroundColor Green

# Fresh demo folder with copies of the (fictional) sample evidence.
if (Test-Path $demo) { Remove-Item -Recurse -Force $demo }
New-Item -ItemType Directory $demo | Out-Null
Copy-Item (Join-Path $root "web\samples\*") $demo
Set-Location $demo
Pause-Demo

Step "1. Open a case and log three pieces of evidence"
Run init --case CV-2026-0142 --title "People v. Dela Cruz (fictional)" --by "Atty. M. Cruz"
Run add witness_statement.txt --by "Atty. M. Cruz" --category "Document" --desc "Signed witness statement"
Run add call_log.csv --by "Atty. M. Cruz" --category "Device extraction" --desc "Call log from respondent's phone"
Run add scene_sketch.svg --by "Atty. M. Cruz" --category "Scene sketch" --desc "Investigator's scene sketch"
Pause-Demo

Step "2. Only authorized custodians may receive evidence"
Write-Host "  Trying to send the call log to a lab that is NOT on the authorized list:" -ForegroundColor DarkGray
Run transfer 2 --by "Atty. M. Cruz" --to "NBI Cybercrime Division" --reason "Metadata extraction"
Write-Host "`n  So first we add the lab to the authorized custodian list:" -ForegroundColor DarkGray
Run authorize "NBI Cybercrime Division" --role "Law enforcement" --by "Atty. M. Cruz" --note "Accredited cybercrime unit"
Run custodians
Pause-Demo

Step "3. Transfer custody of the call log to the lab and back"
Run transfer 2 --by "Atty. M. Cruz" --to "NBI Cybercrime Division" --reason "Metadata extraction"
Run transfer 2 --by "NBI Cybercrime Division" --to "Atty. M. Cruz" --reason "Analysis complete"
Write-Host "`n  Only the current custodian can transfer an item. Watch what happens if someone else tries:" -ForegroundColor DarkGray
Run transfer 1 --by "NBI Cybercrime Division" --to "Atty. M. Cruz"
Pause-Demo

Step "4. Where is everything, and what happened to the call log?"
Run list
Run history 2
Pause-Demo

Step "5. Verify: everything should be intact"
Run verify
$anchor = (& $exe head).Trim()
Write-Host "`n  Saving the head hash as our 'anchor' (in real life: emailed to the client): $($anchor.Substring(0,16))..." -ForegroundColor DarkGray
Pause-Demo

Step "6. ATTACK: someone edits an evidence file after it was logged"
$original = Get-Content call_log.csv -Raw
Add-Content call_log.csv "2026-11-03T23:59:00+08:00,outgoing,+63 900 000 0009,5,INSERTED LATER"
Write-Host "  (added one fake line to call_log.csv)" -ForegroundColor Red
Run verify
Set-Content call_log.csv $original -NoNewline
Write-Host "`n  (restored the original file)" -ForegroundColor DarkGray
Pause-Demo

Step "7. ATTACK: someone edits the ledger itself"
$ledger = Get-Content custody.json -Raw
$ledger.Replace("Signed witness statement", "Unsigned draft statement") | Set-Content custody.json -NoNewline
Write-Host "  (changed a description inside custody.json)" -ForegroundColor Red
Run verify --no-files
Set-Content custody.json $ledger -NoNewline
Write-Host "`n  (restored the original ledger)" -ForegroundColor DarkGray
Pause-Demo

Step "8. ATTACK: someone rewrites the whole history from scratch"
Move-Item custody.json custody.real.json
& $exe init --case CV-2026-0142 --title "People v. Dela Cruz (fictional)" --by "Atty. M. Cruz" | Out-Null
& $exe add witness_statement.txt --by "Atty. M. Cruz" --desc "Signed witness statement" | Out-Null
Write-Host "  (built a brand-new, internally consistent fake ledger)" -ForegroundColor Red
Write-Host "  Without the anchor it looks fine:" -ForegroundColor DarkGray
Run verify --no-files
Write-Host "`n  With the anchor hash we saved in step 5, the rewrite is exposed:" -ForegroundColor DarkGray
Run verify --no-files --anchor $anchor
Remove-Item custody.json
Move-Item custody.real.json custody.json
Pause-Demo

Step "9. Back to the real ledger: verified again"
Run verify --anchor $anchor

Write-Host "`n  Demo finished. The demo files are in the demo\ folder." -ForegroundColor Green
Write-Host "  For the web version run the task 'Web app: open in browser'." -ForegroundColor Green
