#!/bin/sh

# Auto-update yt-dlp to the absolute latest nightly/pre-release version on startup to bypass extraction blocks
echo "Checking and updating yt-dlp to the latest nightly/pre-release build..."
pip install -U --pre --no-cache-dir "yt-dlp[default,curl-cffi]"

echo "Checking and updating yt-dlp-get-pot plugin..."
pip install -U --no-cache-dir yt-dlp-get-pot

# Execute the main command (python worker.py)
exec "$@"
