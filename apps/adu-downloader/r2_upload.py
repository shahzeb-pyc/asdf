import hashlib
import mimetypes
import os

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config

from config import (
    R2_ACCESS_KEY_ID,
    R2_ACCOUNT_ID,
    R2_BUCKET,
    R2_SECRET_ACCESS_KEY,
    R2_UPLOAD_CHUNK_BYTES,
)


class _HashingReader:
    """File-like wrapper: read in chunks, update SHA-256, forward to boto3 upload_fileobj."""

    __slots__ = ("_file", "_hasher")

    def __init__(self, file_obj):
        self._file = file_obj
        self._hasher = hashlib.sha256()

    def read(self, amt=None):
        if amt is None or amt < 0:
            amt = R2_UPLOAD_CHUNK_BYTES
        chunk = self._file.read(amt)
        if chunk:
            self._hasher.update(chunk)
        return chunk

    def readable(self):
        return True


def get_s3_client():
    if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY]):
        raise RuntimeError("R2 credentials are required")
    endpoint = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def object_key(page_id: str, reel_internal_id: str) -> str:
    # page_id is the adu_config id and reel_internal_id the adu_reels
    # uuid in the new app (old: page uuid + bigint reel id). Key pattern
    # is unchanged: adu-buffer/<config>/<reel>.mp4
    return f"adu-buffer/{page_id}/{reel_internal_id}.mp4"


def upload_file(local_path: str, key: str) -> tuple[int, str, str]:
    file_size = os.path.getsize(local_path)
    content_type = mimetypes.guess_type(local_path)[0] or "video/mp4"
    client = get_s3_client()
    transfer_config = TransferConfig(
        multipart_threshold=R2_UPLOAD_CHUNK_BYTES,
        multipart_chunksize=R2_UPLOAD_CHUNK_BYTES,
        max_concurrency=1,
    )
    with open(local_path, "rb") as raw_file:
        reader = _HashingReader(raw_file)
        client.upload_fileobj(
            reader,
            R2_BUCKET,
            key,
            ExtraArgs={"ContentType": content_type},
            Config=transfer_config,
        )
        sha256 = reader._hasher.hexdigest()
    return file_size, content_type, sha256
