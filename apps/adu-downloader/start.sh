#!/bin/bash

# Exit on error
set -e

# Path to the downloader directory
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

# Ensure scripts have execute permissions
chmod +x entrypoint.sh start.sh 2>/dev/null || true

echo "=========================================================="
echo "Starting fbuploadpro-downloader service..."
echo "=========================================================="

# Check if Docker is installed
if ! [ -x "$(command -v docker)" ]; then
    echo "Docker is not installed! Installing Docker..."
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
    sudo sh /tmp/get-docker.sh
    rm -f /tmp/get-docker.sh
fi

# Ensure docker service is running and enabled on boot
if systemctl list-unit-files | grep -q "docker.service"; then
    echo "Enabling and starting Docker service..."
    sudo systemctl enable docker
    sudo systemctl start docker
fi

# Check if .env file exists
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo "Creating .env file from .env.example..."
        cp .env.example .env
        echo "WARNING: Created default .env. Please fill in your credentials!"
    else
        echo "ERROR: .env file not found!"
        exit 1
    fi
fi

# Build and start container in detached mode (background)
echo "Building and launching container in the background..."
sudo docker compose up -d --build

echo "=========================================================="
echo "SUCCESS: Downloader service is running in the background!"
echo "It will automatically restart on server boot or failure."
echo "=========================================================="
echo "Tailing logs... (Press Ctrl+C to exit log view; container will keep running)"
echo "=========================================================="

sudo docker compose logs -f
