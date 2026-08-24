$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
    Write-Host '1/3 Checking recovery JavaScript syntax...' -ForegroundColor Cyan
    node --check .\bridge-runner.js
    node --check .\bridge-coordinator.js
    node --check .\bridge.js
    if ($LASTEXITCODE -ne 0) { throw 'Recovery syntax check failed.' }

    Write-Host '2/3 Running resume and state-transition tests...' -ForegroundColor Cyan
    node --test --test-reporter=spec .\test\bridge-runner.test.js .\test\bridge-coordinator.test.js
    if ($LASTEXITCODE -ne 0) { throw 'Recovery tests failed.' }

    Write-Host '3/3 Checking recovery files...' -ForegroundColor Cyan
    foreach ($file in @(
        '.\bridge-runner.js',
        '.\bridge-coordinator.js',
        '.\bridge.js',
        '.\test\bridge-runner.test.js',
        '.\test\bridge-coordinator.test.js'
    )) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing recovery file: $file" }
    }

    Write-Host 'Recovery evaluation passed.' -ForegroundColor Green
} finally {
    Pop-Location
}
