$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root 'reverse_face_search.py'
$out = Join-Path $root 'reverse_face_search.out.log'
$err = Join-Path $root 'reverse_face_search.err.log'
$port = 2299

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Reverse face search is already listening on http://127.0.0.1:$port/"
    return
}

$process = Start-Process `
    -FilePath 'python' `
    -ArgumentList @($script, '--host', '127.0.0.1', '--port', "$port") `
    -PassThru `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err

Write-Host "Reverse face search started on http://127.0.0.1:$port/ with PID $($process.Id)"
