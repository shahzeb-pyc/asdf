FROM python:3.11-slim

# Install system dependencies including ffmpeg, aria2, nodejs for yt-dlp signature processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    aria2 \
    nodejs \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user: the image previously ran as root (Sonar S6471).
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Set working directory
WORKDIR /app

# Copy requirements file
COPY requirements.txt .

# Install python dependencies: versions are pinned inline here because
# static analysis cannot see pins inside a requirements file (Sonar
# S8541/S8544). requirements.txt carries the same pins for local dev
# (see README); keep the two lists in sync when bumping.
RUN pip install --no-cache-dir --only-binary :all: \
    boto3==1.43.122 \
    python-dotenv==1.2.4 \
    supabase==2.33.0 \
    pycryptodomex==3.24.1 \
    yt-dlp-get-pot==0.3.0 \
    "yt-dlp[default,curl-cffi]==2026.10.26"

# Copy application source explicitly (Sonar S6470): COPY . . would
# also copy .env files, caches and logs into the image. The .dockerignore
# exclusion of .env* is kept as a second layer, but the explicit list is
# what guarantees nothing sensitive is copied.
COPY worker.py entrypoint.sh config.py db.py caption_utils.py local_cache.py logging_setup.py media_download.py r2_upload.py sources.py start.sh .

# Ensure entrypoint script is executable
RUN chmod +x /app/entrypoint.sh

# Create cache and log directories owned by the runtime user
RUN mkdir -p cache logs && chown -R appuser:appuser /app

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV ADU_DOWNLOADER_CACHE_DIR=/app/cache
ENV ADU_DOWNLOADER_LOG_DIR=/app/logs

USER appuser

# Set entrypoint to run updates on startup
ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]

# Run the worker script
CMD ["python", "worker.py"]
