# setup-ollama-windows.ps1 — Install and configure Ollama on Windows
# Run in PowerShell as Administrator:
#   Set-ExecutionPolicy Bypass -Scope Process -Force
#   .\scripts\setup-ollama-windows.ps1
# Optional: pass a model name as argument, e.g.:
#   .\scripts\setup-ollama-windows.ps1 -Model "mistral"

param(
    [string]$Model = "llama3.2"    # Default model; use "gemma2:2b" for lower-RAM machines
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== Ollama setup for Windows ===" -ForegroundColor Cyan
Write-Host "    Model: $Model"
Write-Host ""

# ── 1. Install Ollama ──────────────────────────────────────────────────────────
$ollamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
if (Test-Path $ollamaExe) {
    Write-Host "[skip] Ollama already installed at $ollamaExe"
} else {
    Write-Host "[1/4] Downloading Ollama installer..."
    $installerUrl = "https://ollama.com/download/OllamaSetup.exe"
    $installerPath = "$env:TEMP\OllamaSetup.exe"
    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing
    Write-Host "      Running installer (silent)..."
    Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait
    Write-Host "      Done."
}

# Ensure ollama is in PATH for this session
$env:PATH = "$env:LOCALAPPDATA\Programs\Ollama;$env:PATH"

# ── 2. Set OLLAMA_HOST to listen on all interfaces ────────────────────────────
Write-Host "[2/4] Setting OLLAMA_HOST=0.0.0.0 (machine-level environment variable)..."
[System.Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0", "Machine")
$env:OLLAMA_HOST = "0.0.0.0"
Write-Host "      Done (takes effect on next Ollama start)."

# ── 3. Restart Ollama (stop any running instance, start fresh) ────────────────
Write-Host "[3/4] Restarting Ollama service..."
Get-Process -Name "ollama" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
Start-Process -FilePath $ollamaExe -ArgumentList "serve" -WindowStyle Hidden

# Wait for Ollama to be ready
Write-Host -NoNewline "      Waiting for Ollama to start"
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    Write-Host -NoNewline "."
    try {
        $null = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 2
        $ready = $true
        break
    } catch {}
}
if ($ready) { Write-Host " ready." } else { Write-Host " (timed out — continuing anyway)" }

# ── 4. Pull the model ──────────────────────────────────────────────────────────
Write-Host "[4/4] Pulling model: $Model  (this may take a while on first run)"
& $ollamaExe pull $Model
Write-Host "      Model downloaded."

# ── Done ───────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Green
Write-Host ""
Write-Host "  Ollama is running at: http://localhost:11434"

# Show local IPs
$ips = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notmatch "^127\." -and $_.PrefixOrigin -ne "WellKnown" } |
        Select-Object -ExpandProperty IPAddress) -join ", "
if ($ips) { Write-Host "  From other devices:   $($ips.Split(',')[0].Trim()):11434" }

Write-Host "  Model in use:         $Model"
Write-Host ""
Write-Host "  In WA Assistant → Settings → Integrations → Ollama:"
if ($ips) {
    $firstIp = $ips.Split(',')[0].Trim()
    Write-Host "    URL:   http://${firstIp}:11434"
} else {
    Write-Host "    URL:   http://localhost:11434"
}
Write-Host "    Model: $Model"
Write-Host ""
Write-Host "  NOTE: Ollama starts automatically with Windows after installation."
Write-Host "  If you close the hidden window, restart it by running: ollama serve"
Write-Host ""
Write-Host "  Tip: for machines with <8 GB RAM, use:"
Write-Host "    .\scripts\setup-ollama-windows.ps1 -Model gemma2:2b"
