#!/bin/bash
set -euo pipefail

echo "==================================================="
echo "  Virtual Browser - Quick Install for Debian 13    "
echo "==================================================="

# 1. Install system dependencies
echo "[*] Installing required system packages (Git & Docker)..."
sudo apt-get update -y -q
sudo apt-get install -y git docker.io curl

# Ensure Docker is enabled and running
sudo systemctl enable --now docker

# 2. Clone or update the repository
REPO_URL="https://github.com/merlinthedev848/browser.git"
INSTALL_DIR="virtual-browser"

if [ -d "$INSTALL_DIR/.git" ]; then
    echo "[*] Existing installation found — updating to latest version..."
    cd "$INSTALL_DIR"
    git fetch origin main
    git reset --hard origin/main
else
    echo "[*] Cloning the Virtual Browser repository..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# 3. Ensure persistent data directory exists
echo "[*] Setting up persistent storage..."
mkdir -p browser_data

# 4. Ask for password
echo ""
# Detect existing password from running container
EXISTING_PASSWORD=""
if sudo docker ps -a --format '{{.Names}}' | grep -q "^vbrowser$"; then
    EXISTING_PASSWORD=$(sudo docker inspect --format='{{range .Config.Env}}{{if eq (slice . 0 9) "PASSWORD="}}{{slice . 9}}{{end}}{{end}}' vbrowser 2>/dev/null || true)
fi

if [ -n "$EXISTING_PASSWORD" ]; then
    USER_PASSWORD="$EXISTING_PASSWORD"
    echo "[*] Reusing existing secure password from running container."
else
    echo "Enter a secure password for your Virtual Browser"
    echo "(Leave blank to use the default: 'password123'):"
    
    # Check if stdin is a tty (e.g. run via ./install.sh)
    if [ -t 0 ]; then
        read -s -r USER_PASSWORD # Use -s to hide password input for security
        echo ""
    else
        # Piped script (e.g. curl ... | bash), read from controlling tty
        read -s -r USER_PASSWORD </dev/tty 2>/dev/null || USER_PASSWORD=""
        echo ""
    fi

    if [ -z "$USER_PASSWORD" ]; then
        USER_PASSWORD="password123"
        echo "[!] Using default password: password123"
    fi
fi

# 5. Build Docker image
echo ""
echo "[*] Building Docker image (this may take a few minutes on first run)..."
sudo docker build -t virtual-browser .

# 6. Stop and remove any existing container
if sudo docker ps -a --format '{{.Names}}' | grep -q "^vbrowser$"; then
    echo "[*] Removing existing container..."
    sudo docker rm -f vbrowser
fi

# 7. Start the container
echo ""
echo "[*] Starting the Virtual Browser container..."
sudo docker run -d \
    --name vbrowser \
    -p 3000:3000 \
    -e PASSWORD="$USER_PASSWORD" \
    -v "$(pwd)/browser_data:/usr/src/app/browser_data" \
    --shm-size 256m \
    --restart unless-stopped \
    virtual-browser

# 8. Wait briefly and confirm the container started
sleep 2
if sudo docker ps --format '{{.Names}}' | grep -q "^vbrowser$"; then
    echo ""
    echo "==================================================="
    echo "  INSTALLATION COMPLETE!                           "
    echo "==================================================="
    echo ""
    echo "  Container: vbrowser (running)"
    echo "  Port:      3000"
    echo "  Password:  $USER_PASSWORD"
    echo ""
    echo "  If using a reverse proxy (e.g. Nginx), point it"
    echo "  to http://<this-container-ip>:3000"
    echo ""
    echo "  WebSocket upgrade headers are required:"
    echo "    proxy_http_version 1.1;"
    echo "    proxy_set_header Upgrade \$http_upgrade;"
    echo "    proxy_set_header Connection \"upgrade\";"
    echo "==================================================="
else
    echo ""
    echo "[!] Container failed to start. Check logs with:"
    echo "    docker logs vbrowser"
    exit 1
fi
