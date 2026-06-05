# AeroLink – Start Docker Stack (Checks if Docker is running)

Write-Host "Checking if Docker daemon is running..." -ForegroundColor Cyan

# Test if docker commands work
$dockerInfo = docker info 2>&1

if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker is not running. Starting Docker Desktop..." -ForegroundColor Yellow
    
    $dockerPath = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerPath) {
        Start-Process $dockerPath
        
        Write-Host "Waiting for Docker to start (this may take up to 60 seconds)..." -ForegroundColor Yellow
        
        $maxWait = 60
        $waited = 0
        $dockerReady = $false
        
        while ($waited -lt $maxWait) {
            Start-Sleep -Seconds 2
            $waited += 2
            
            # Check if docker commands work now
            docker info 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) {
                $dockerReady = $true
                break
            }
        }
        
        if (-not $dockerReady) {
            Write-Error "Docker Desktop failed to start within 60 seconds. Please start it manually."
            exit 1
        }
        
        Write-Host "Docker is now running." -ForegroundColor Green
    } else {
        Write-Error "Docker Desktop executable not found at '$dockerPath'. Please install Docker or start it manually."
        exit 1
    }
} else {
    Write-Host "Docker is running." -ForegroundColor Green
}

# Stop any lingering node processes holding ports just in case
Write-Host "Cleaning up lingering node processes..." -ForegroundColor Cyan
@(3000, 3001, 3002, 3003, 3004, 4005, 5173, 5174) | ForEach-Object {
    $port = $_
    $lines = netstat -ano 2>$null | Select-String ":$port\s" | Select-String "LISTENING"
    foreach ($line in $lines) {
        $pid_ = ($line -split '\s+')[-1].Trim()
        if ($pid_ -match '^\d+$' -and $pid_ -ne '0') {
            try {
                Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue
                Write-Host "  Killed local PID $pid_ on port $port" -ForegroundColor Yellow
            } catch {}
        }
    }
}

Write-Host "Starting AeroLink Docker Stack..." -ForegroundColor Cyan
# Rebuild in case code changed, start detached
docker-compose up --build -d

Write-Host "Following logs..." -ForegroundColor Cyan
docker-compose logs -f
