$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
    Write-Host '1/3 Checking JavaScript syntax...' -ForegroundColor Cyan
    Get-ChildItem -File -Filter '*.js' | ForEach-Object {
        node --check $_.FullName
        if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $($_.Name)" }
    }

    Write-Host '2/3 Running regular and pre-production tests...' -ForegroundColor Cyan
    node --test --test-reporter=spec .\test\*.test.js
    if ($LASTEXITCODE -ne 0) { throw 'Pre-production evaluation tests failed.' }

    Write-Host '3/3 Checking required files...' -ForegroundColor Cyan
    $required = @(
        '.\bridge-coordinator.js', '.\bridge-adapter.js', '.\bridge-actions.js', '.\bridge-policy.js',
        '.\bridge-runner.js', '.\bridge-inspector.js', '.\bridge.js', '.\inspector.html', '.\inspector-control-room.js', '.\README.md'
    )
    foreach ($file in $required) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing required file: $file" }
    }
    Write-Host 'Pre-production evaluation passed.' -ForegroundColor Green
} finally {
    Pop-Location
}