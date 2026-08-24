$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
    Write-Host '1/3 Checking Control Room JavaScript syntax...' -ForegroundColor Cyan
    node --check .\bridge-inspector.js
    node --check .\inspector-control-room.js
    node --check .\bridge.js
    if ($LASTEXITCODE -ne 0) { throw 'Control Room syntax check failed.' }

    Write-Host '2/3 Running focused Control Room and watch tests...' -ForegroundColor Cyan
    node --test --test-reporter=spec .\test\bridge-control-room.test.js .\test\bridge-inspector.test.js .\test\bridge-watch.test.js
    if ($LASTEXITCODE -ne 0) { throw 'Focused Control Room tests failed.' }

    Write-Host '3/3 Checking Control Room files...' -ForegroundColor Cyan
    foreach ($file in @(
        '.\bridge-inspector.js',
        '.\inspector.html',
        '.\inspector-control-room.js',
        '.\bridge.js',
        '.\test\bridge-control-room.test.js',
        '.\test\bridge-watch.test.js'
    )) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing Control Room file: $file" }
    }

    Write-Host 'Control Room evaluation passed.' -ForegroundColor Green
} finally {
    Pop-Location
}
