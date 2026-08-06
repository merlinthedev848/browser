#!/bin/bash
set -e

echo "==================================================="
echo "  Virtual Browser - Quick Install for Debian 13    "
echo "==================================================="

# 1. Update and install dependencies
echo "[*] Installing required system packages (Git & Docker)..."
sudo apt-get update -y
sudo apt-get install -y git docker.io curl

# Ensure Docker is running
sudo systemctl enable --now docker

# 2. Clone the repository if not already in it
if [ ! -f "Dockerfile" ] || [ ! -f "server.js" ]; then
    echo "[*] Cloning the Virtual Browser repository..."
    if [ -d "virtual-browser" ]; then
        echo "[!] Directory 'virtual-browser' already exists. Removing it..."
        rm -rf virtual-browser
    fi
    git clone https://github.com/merlinthedev848/browser.git virtual-browser
    cd virtual-browser
fi

# 3. Create persistent data directory
echo "[*] Setting up persistent storage..."
mkdir -p browser_data

# 4. Ask for a secure password
echo ""
read -p "Enter a secure password for your Virtual Browser (leave blank to use 'password123'): " USER_PASSWORD
if [ -z "$USER_PASSWORD" ]; then
    USER_PASSWORD="password123"
    echo "[!] Using default password: password123"
fi

# 5. Build the Docker Image
echo ""
echo "[*] Building the Docker image (this may take a few minutes to download Playwright dependencies)..."
sudo docker build -t virtual-browser .

# 6. Stop and remove existing container if it exists
if sudo docker ps -a --format '{{.Names}}' | grep -q "^vbrowser$"; then
    echo "[*] Removing existing 'vbrowser' container..."
    sudo docker rm -f vbrowser
fi

# 7. Run the container
echo ""
echo "[*] Starting the Virtual Browser container..."
sudo docker run -d \
    --name vbrowser \
    -p 3000:3000 \
    -e PASSWORD="$USER_PASSWORD" \
    -v $(pwd)/browser_data:/usr/src/app/browser_data \
    --restart unless-stopped \
    virtual-browser

# 8. Finish
SERVER_IP=$(curl -s ifconfig.me || echo "<YOUR_SERVER_IP>")
echo ""
echo "==================================================="
echo "  INSTALLATION COMPLETE!                           "
echo "==================================================="
echo "Your secure Virtual Browser is now running."
echo ""
echo "Access it at: http://$SERVER_IP:3000"
echo "Password:     $USER_PASSWORD"
echo ""
echo "Note: For production use, it is highly recommended to run this"
echo "behind a reverse proxy (like Nginx/Caddy) to enable HTTPS."
echo "==================================================="
