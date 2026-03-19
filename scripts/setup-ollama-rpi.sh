#!/usr/bin/env bash
# setup-ollama-rpi.sh — Install and configure Ollama on Linux / Raspberry Pi
# Run as: sudo bash scripts/setup-ollama-rpi.sh
# Tested on: Raspberry Pi OS (Bookworm/Bullseye), Ubuntu 22.04+, Debian 12+

set -euo pipefail

OLLAMA_MODEL="${1:-gemma2:2b}"   # Default: gemma2:2b — best quality/speed for RPi 4
OLLAMA_HOST="0.0.0.0"            # Listen on all interfaces (so the frontend can reach it)

echo "=== Ollama setup for Linux / Raspberry Pi ==="
echo "    Model: $OLLAMA_MODEL"
echo ""

# ── 1. Install Ollama ──────────────────────────────────────────────────────────
if command -v ollama &>/dev/null; then
  echo "[skip] Ollama already installed ($(ollama --version 2>/dev/null || echo 'version unknown'))"
else
  echo "[1/4] Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
  echo "      Done."
fi

# ── 2. Configure systemd to listen on 0.0.0.0 ─────────────────────────────────
echo "[2/4] Configuring Ollama to listen on all interfaces..."
OVERRIDE_DIR="/etc/systemd/system/ollama.service.d"
OVERRIDE_FILE="$OVERRIDE_DIR/override.conf"

mkdir -p "$OVERRIDE_DIR"
cat > "$OVERRIDE_FILE" <<EOF
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
EOF

systemctl daemon-reload
echo "      Written: $OVERRIDE_FILE"

# ── 3. Enable & restart Ollama service ────────────────────────────────────────
echo "[3/4] Enabling and starting Ollama service..."
systemctl enable ollama
systemctl restart ollama

# Wait for Ollama to be ready
echo -n "      Waiting for Ollama to start"
for i in $(seq 1 20); do
  if curl -sf http://localhost:11434/api/tags &>/dev/null; then
    echo " ready."
    break
  fi
  echo -n "."
  sleep 1
done

# ── 4. Pull the model ──────────────────────────────────────────────────────────
echo "[4/4] Pulling model: $OLLAMA_MODEL  (this may take a while on first run)"
ollama pull "$OLLAMA_MODEL"
echo "      Model downloaded."

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo "=== Setup complete! ==="
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "your-pi-ip")
echo ""
echo "  Ollama is running at: http://localhost:11434"
echo "  From other devices:   http://${LOCAL_IP}:11434"
echo "  Model in use:         $OLLAMA_MODEL"
echo ""
echo "  In WA Assistant → Settings → Integrations → Ollama:"
echo "    URL:   http://${LOCAL_IP}:11434"
echo "    Model: $OLLAMA_MODEL"
echo ""
echo "  Tip: for Raspberry Pi 3 or low-RAM devices, use:"
echo "    bash scripts/setup-ollama-rpi.sh tinyllama"
