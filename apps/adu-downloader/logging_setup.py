import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

from config import LOG_BACKUP_COUNT, LOG_DIR, LOG_MAX_BYTES

LOG_FORMAT = "%(asctime)s %(levelname)s %(message)s"
LOGGER_NAME = "adu-downloader"


def configure_logging() -> Path:
    """Console (stdout) + rotating files under LOG_DIR (Linux and Windows)."""
    log_dir = Path(LOG_DIR)
    log_dir.mkdir(parents=True, exist_ok=True)

    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    logger.handlers.clear()

    formatter = logging.Formatter(LOG_FORMAT)

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(logging.INFO)
    console.setFormatter(formatter)
    logger.addHandler(console)

    combined = RotatingFileHandler(
        log_dir / "adu-downloader.log",
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    combined.setLevel(logging.INFO)
    combined.setFormatter(formatter)
    logger.addHandler(combined)

    errors = RotatingFileHandler(
        log_dir / "adu-downloader.error.log",
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    errors.setLevel(logging.WARNING)
    errors.setFormatter(formatter)
    logger.addHandler(errors)

    return log_dir
