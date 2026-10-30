"""pytest bootstrap for the downloader's pure-function tests.

The modules under test are imported as top-level modules (the
downloader runs as `python worker.py` from its own directory, not as
a package), so the tests directory's parent is added to sys.path.
Only pure modules are imported here: caption_utils, config,
r2_upload (object_key only — no S3 client is created at import) and
local_cache (path helpers only). db.py / worker.py are NOT imported:
they need live Supabase credentials.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
