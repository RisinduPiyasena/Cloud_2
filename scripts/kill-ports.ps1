# AeroLink – Kill all ports used by the dev stack before starting
# Ports: 3000 (gateway), 3001 (booking), 3002 (baggage), 3003 (checkin),
#        3004 (flight-ops), 4005 (auth), 5173/5174 (vite)

$ports = @(3000, 3001, 3002, 3003, 3004, 4005, 5173, 5174)

Write-Host "Stopping Docker containers..." -ForegroundColor Cyan
docker compose down 2>&1 | Out-Null

Write-Host "Killing processes on dev ports..." -ForegroundColor Cyan
foreach ($port in $ports) {
    # netstat gives us the PID in the last column for LISTENING lines
    $lines = netstat -ano 2>$null | Select-String ":$port\s" | Select-String "LISTENING"
    foreach ($line in $lines) {
        $pid_ = ($line -split '\s+')[-1].Trim()
        if ($pid_ -match '^\d+$' -and $pid_ -ne '0') {
            try {
                Stop-Process -Id $pid_ -Force -ErrorAction Stop
                Write-Host "  Killed PID $pid_ on port $port" -ForegroundColor Yellow
            } catch {}
        }
    }
}

Write-Host "All ports cleared." -ForegroundColor Green
Start-Sleep -Seconds 1
