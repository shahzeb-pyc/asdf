'use client';

/**
 * Composer staged uploads (media/posting separation).
 *
 * Device uploads made inside the Create Posts composer go HERE, not
 * to the Media Library: bytes land under the user's post-staging
 * prefix, no `media_items` row is ever created, and nothing appears
 * in the library listing or its cache. At queue time the route
 * adopts the staged key as the post's own media.
 *
 * Deliberately smaller than the library's import modal: uploads run
 * sequentially (one file at a time), with per-file progress, retry,
 * and cancel — no pause/resume, no duplicate flags, no destination
 * picker (there is no destination: staged bytes belong to the post).
 * Files over 8 MiB go multipart in 8 MiB parts, like the library
 * flow; a failed multipart file restarts from scratch on retry
 * (no part resume in v1 — the library modal keeps that job).
 *
 * Metadata is probed client-side (dimensions, video duration) so
 * the composer can derive the post type (reel vs video post) and
 * the route can run format eligibility without a library row. A
 * failed probe never blocks the upload: the file still uploads with
 * unknown facts, and the route treats unknown facts as passing,
 * exactly as it treats null library facts.
 *
 * Thumbnails: images reuse the media URL itself; videos capture a
 * frame when possible, else no thumbnail (the attached card already
 * renders without one).
 *
 * Cleanup: staged bytes that are never queued are removed by the
 * server-side lazy sweep (24h retention, queue-referenced keys
 * kept). Closing the composer without queueing does not delete
 * anything immediately — the sweep owns that job.
 */

import * as React from 'react';
import {
  AllowedMediaMimeTypes,
  deriveDefaultCaptionFromFilename,
  MultipartCompleteResponseSchema,
  MultipartInitiateResponseSchema,
  MultipartPartUrlResponseSchema,
  UploadUrlResponseSchema,
  type ComposerMedia,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/shared/ui/button';
import { captureVideoFrameAsWebp } from '@/components/media/video-frame-capture';

const SINGLE_PUT_MAX_BYTES = 8 * 1024 * 1024;
const MULTIPART_PART_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 524288000; // 500 MB, same as the server cap.

type StagedFileStatus = 'queued' | 'uploading' | 'done' | 'error';

interface StagedFileState {
  id: string;
  file: File;
  status: StagedFileStatus;
  progressPercent: number;
  error: string | null;
  /** XHR of the in-flight PUT, for cancel. Null when idle. */
  xhr: XMLHttpRequest | null;
  /** Multipart upload id, for abort on cancel. Null when unused. */
  multipartUploadId: string | null;
  multipartKey: string | null;
}

export interface ComposerStagedUploadProps {
  subdomain: string;
  mode: 'single' | 'multi';
  onSuccess: (media: ComposerMedia) => void;
  onActiveChange?: (
    count: number,
    furthestAlong: { name: string; progressPercent: number } | null
  ) => void;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function putWithProgress(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
  registerXhr: (xhr: XMLHttpRequest | null) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    registerXhr(xhr);
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      registerXhr(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed (${xhr.status}). Please try again.`));
      }
    };
    xhr.onerror = () => {
      registerXhr(null);
      reject(new Error('Upload failed. Check your connection and try again.'));
    };
    xhr.onabort = () => {
      registerXhr(null);
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };
    xhr.send(body);
  });
}

interface ProbedMetadata {
  width: number | null;
  height: number | null;
  aspectRatio: string;
  durationSeconds: number | null;
}

function probeFileMetadata(file: File): Promise<ProbedMetadata> {
  const fallback: ProbedMetadata = {
    width: null,
    height: null,
    aspectRatio: 'unknown',
    durationSeconds: null,
  };
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const done = (meta: ProbedMetadata) => {
      URL.revokeObjectURL(objectUrl);
      resolve(meta);
    };
    try {
      if (file.type.startsWith('image/')) {
        const img = new Image();
        img.onload = () => {
          const width = img.naturalWidth || null;
          const height = img.naturalHeight || null;
          done({
            width,
            height,
            aspectRatio:
              width && height ? `${width}:${height}` : 'unknown',
            durationSeconds: null,
          });
        };
        img.onerror = () => done(fallback);
        img.src = objectUrl;
      } else {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => {
          const width = video.videoWidth || null;
          const height = video.videoHeight || null;
          done({
            width,
            height,
            aspectRatio:
              width && height ? `${width}:${height}` : 'unknown',
            durationSeconds:
              Number.isFinite(video.duration) && video.duration > 0
                ? video.duration
                : null,
          });
        };
        video.onerror = () => done(fallback);
        video.src = objectUrl;
      }
    } catch {
      done(fallback);
    }
  });
}

async function captureVideoThumbnail(
  file: File,
  thumbnailUploadUrl: string | null
): Promise<boolean> {
  if (!thumbnailUploadUrl) return false;
  try {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('video load failed'));
      video.src = objectUrl;
    });
    try {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        setTimeout(resolve, 1000);
      });
    } catch (error) {
      // Seeking is best-effort — the first frame is used when it
      // fails — but the failure is surfaced, never swallowed.
      console.warn('Video seek failed; using the first frame instead.', error);
    }
    const frame = await captureVideoFrameAsWebp(video);
    URL.revokeObjectURL(objectUrl);
    if (!frame.blob) return false;
    await fetch(thumbnailUploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: frame.blob,
    });
    return true;
  } catch {
    return false;
  }
}

export function ComposerStagedUpload({
  subdomain,
  mode,
  onSuccess,
  onActiveChange,
}: Readonly<ComposerStagedUploadProps>) {
  const [files, setFiles] = React.useState<StagedFileState[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const filesRef = React.useRef<StagedFileState[]>([]);
  filesRef.current = files;
  const runningRef = React.useRef(false);
  const onSuccessRef = React.useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const reportActive = React.useCallback(() => {
    const current = filesRef.current;
    const uploading = current.filter((f) => f.status === 'uploading');
    const furthest =
      uploading.length > 0
        ? {
            name: uploading[0].file.name,
            progressPercent: uploading[0].progressPercent,
          }
        : null;
    onActiveChange?.(uploading.length, furthest);
  }, [onActiveChange]);

  const setFileState = React.useCallback(
    (id: string, patch: Partial<StagedFileState>) => {
      setFiles((prev) =>
        prev.map((f) => (f.id === id ? { ...f, ...patch } : f))
      );
    },
    []
  );

  const uploadOne = React.useCallback(
    async (entry: StagedFileState): Promise<void> => {
      const file = entry.file;
      const isVideo = file.type.startsWith('video/');
      const mediaType = isVideo ? 'video' : 'image';
      setFileState(entry.id, { status: 'uploading', progressPercent: 0, error: null });
      // Declared outside the try so the catch can abort a failed
      // multipart upload (try-scoped lets are invisible to catch).
      let mediaKey = '';
      let uploadId: string | null = null;
      try {
        const metadata = await probeFileMetadata(file);
        const totalBytes = file.size;
        let publicMediaUrl: string;
        let thumbnailUploadUrl: string | null = null;
        let publicThumbnailUrl: string | null = null;

        if (totalBytes <= SINGLE_PUT_MAX_BYTES) {
          const presigned = await api.post(
            buildTenantApiPath(subdomain, '/media/upload-url'),
            {
              fileName: file.name,
              fileSize: totalBytes,
              mimeType: file.type,
              purpose: 'post-staging',
            },
            { schema: UploadUrlResponseSchema }
          );
          mediaKey = presigned.mediaKey;
          publicMediaUrl = presigned.publicMediaUrl;
          thumbnailUploadUrl = presigned.thumbnailUploadUrl;
          publicThumbnailUrl = presigned.publicThumbnailUrl;
          await putWithProgress(
            presigned.mediaUploadUrl,
            file,
            file.type,
            (loaded, total) =>
              setFileState(entry.id, {
                progressPercent: Math.round((loaded / Math.max(total, 1)) * 100),
              }),
            (xhr) => setFileState(entry.id, { xhr })
          );
        } else {
          const initiated = await api.post(
            buildTenantApiPath(subdomain, '/media/multipart/initiate'),
            {
              fileName: file.name,
              fileSize: totalBytes,
              mimeType: file.type,
              purpose: 'post-staging',
            },
            { schema: MultipartInitiateResponseSchema }
          );
          mediaKey = initiated.mediaKey;
          publicMediaUrl = initiated.publicMediaUrl;
          thumbnailUploadUrl = initiated.thumbnailUploadUrl;
          publicThumbnailUrl = initiated.publicThumbnailUrl;
          uploadId = initiated.uploadId;
          setFileState(entry.id, {
            multipartUploadId: uploadId,
            multipartKey: mediaKey,
          });
          const partCount = Math.ceil(totalBytes / MULTIPART_PART_BYTES);
          let uploadedBytes = 0;
          for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
            const start = (partNumber - 1) * MULTIPART_PART_BYTES;
            const chunk = file.slice(start, start + MULTIPART_PART_BYTES);
            const partUrl = await api.post(
              buildTenantApiPath(subdomain, '/media/multipart/part-url'),
              { key: mediaKey, uploadId, partNumber },
              { schema: MultipartPartUrlResponseSchema }
            );
            await putWithProgress(
              partUrl.uploadUrl,
              chunk,
              file.type,
              (loaded) => {
                const overall = uploadedBytes + loaded;
                setFileState(entry.id, {
                  progressPercent: Math.round((overall / totalBytes) * 100),
                });
              },
              (xhr) => setFileState(entry.id, { xhr })
            );
            uploadedBytes += chunk.size;
          }
          await api.post(
            buildTenantApiPath(subdomain, '/media/multipart/complete'),
            { key: mediaKey, uploadId, expectedPartCount: partCount },
            { schema: MultipartCompleteResponseSchema }
          );
        }

        // Thumbnail: images reuse the media URL; videos capture a
        // frame when possible (null otherwise — the attached card
        // renders without one).
        let thumbnailUrl: string | null = null;
        if (!isVideo) {
          thumbnailUrl = publicMediaUrl;
        } else if (thumbnailUploadUrl && publicThumbnailUrl) {
          const captured = await captureVideoThumbnail(file, thumbnailUploadUrl);
          thumbnailUrl = captured ? publicThumbnailUrl : null;
        }

        const media: ComposerMedia = {
          id: crypto.randomUUID(),
          name: file.name,
          mediaType,
          aspectRatio: metadata.aspectRatio,
          thumbnailUrl,
          url: publicMediaUrl,
          width: metadata.width,
          height: metadata.height,
          captionText: deriveDefaultCaptionFromFilename(file.name),
          source: 'staged',
          storageKey: mediaKey,
          fileSize: totalBytes,
          durationSeconds: metadata.durationSeconds,
        };
        setFileState(entry.id, { status: 'done', progressPercent: 100, xhr: null });
        onSuccessRef.current(media);
      } catch (error) {
        // A failed multipart file is aborted best-effort so it does
        // not linger server-side (expiry covers any abort failure).
        if (uploadId && mediaKey) {
          void api
            .post(
              buildTenantApiPath(subdomain, '/media/multipart/abort'),
              { key: mediaKey, uploadId },
              {}
            )
            .catch(() => {
              // Best effort only.
            });
        }
        if (error instanceof DOMException && error.name === 'AbortError') {
          setFileState(entry.id, {
            status: 'error',
            error: 'Upload cancelled.',
            xhr: null,
          });
        } else {
          setFileState(entry.id, {
            status: 'error',
            error: errorText(error, 'Upload failed. Please try again.'),
            xhr: null,
          });
        }
      }
    },
    [setFileState, subdomain]
  );

  const runQueue = React.useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        const next = filesRef.current.find((f) => f.status === 'queued');
        if (!next) break;
        await uploadOne(next);
        reportActive();
      }
    } finally {
      runningRef.current = false;
      reportActive();
    }
  }, [reportActive, uploadOne]);

  const addFiles = React.useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const chosen = Array.from(list);
      const accepted: StagedFileState[] = [];
      for (const file of chosen) {
        if (mode === 'single' && accepted.length > 0) break;
        if (
          !(AllowedMediaMimeTypes as readonly string[]).includes(file.type)
        ) {
          accepted.push({
            id: crypto.randomUUID(),
            file,
            status: 'error',
            progressPercent: 0,
            error: 'This file type is not supported here.',
            xhr: null,
            multipartUploadId: null,
            multipartKey: null,
          });
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          accepted.push({
            id: crypto.randomUUID(),
            file,
            status: 'error',
            progressPercent: 0,
            error: 'This file is larger than 500 MB.',
            xhr: null,
            multipartUploadId: null,
            multipartKey: null,
          });
          continue;
        }
        accepted.push({
          id: crypto.randomUUID(),
          file,
          status: 'queued',
          progressPercent: 0,
          error: null,
          xhr: null,
          multipartUploadId: null,
          multipartKey: null,
        });
      }
      if (accepted.length === 0) return;
      setFiles((prev) => [...prev, ...accepted]);
      void runQueue();
    },
    [mode, runQueue]
  );

  const retryFile = React.useCallback(
    (id: string) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? { ...f, status: 'queued', progressPercent: 0, error: null }
            : f
        )
      );
      void runQueue();
    },
    [runQueue]
  );

  const cancelFile = React.useCallback((id: string) => {
    const entry = filesRef.current.find((f) => f.id === id);
    if (!entry) return;
    entry.xhr?.abort();
    if (entry.multipartUploadId && entry.multipartKey) {
      void api
        .post(
          buildTenantApiPath(subdomain, '/media/multipart/abort'),
          { key: entry.multipartKey, uploadId: entry.multipartUploadId },
          {}
        )
        .catch(() => {
          // Best effort: the server-side upload expires on its own.
        });
    }
    setFiles((prev) =>
      prev.map((f) =>
        f.id === id
          ? {
              ...f,
              status: 'error',
              error: 'Upload cancelled.',
              xhr: null,
              multipartUploadId: null,
              multipartKey: null,
            }
          : f
      )
    );
  }, [subdomain]);

  const removeFile = React.useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  // Report live state whenever the file list changes.
  React.useEffect(() => {
    reportActive();
  }, [files, reportActive]);

  return (
    <div
      className={cn(isDragging && 'rounded-md ring-2 ring-link/60 ring-inset')}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      <p className="mb-3 text-body text-ink-sub">
        Uploads stay with this post — they are not added to your Media
        Library. You can also drop files anywhere on this tab.
      </p>
      <input
        ref={inputRef}
        type="file"
        data-testid="media-library-device-input"
        className="hidden"
        accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
        multiple={mode === 'multi'}
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="secondary"
        data-testid="media-library-device-choose-btn"
        onClick={() => inputRef.current?.click()}
      >
        Choose files from your device
      </Button>
      {isDragging && (
        <p className="mt-3 text-center text-body font-medium text-link">
          Drop files to upload them
        </p>
      )}
      {files.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-3 rounded-sm border border-line px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-ink">
                  {f.file.name}
                </span>
                {f.status === 'uploading' && (
                  <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-line">
                    {/* Width is a runtime percentage, so it cannot
                    be a static token class — but it also cannot be
                    an inline style (spec 129 ratchet). An SVG rect
                    carries the percentage as a width attribute,
                    which is neither. */}
                    <svg
                      className="block h-full w-full text-link"
                      aria-hidden="true"
                    >
                      <rect
                        height="100%"
                        width={`${f.progressPercent}%`}
                        fill="currentColor"
                      />
                    </svg>
                  </span>
                )}
                {f.status === 'error' && f.error && (
                  <span className="block text-body text-signal-critical">
                    {f.error}
                  </span>
                )}
                {f.status === 'done' && (
                  <span className="block text-body text-brand-emerald">
                    Uploaded
                  </span>
                )}
              </span>
              {f.status === 'uploading' && (
                <>
                  <span className="shrink-0 text-metadata tabular-nums text-ink-sub">
                    {f.progressPercent}%
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => cancelFile(f.id)}
                  >
                    Cancel
                  </Button>
                </>
              )}
              {f.status === 'error' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => retryFile(f.id)}
                >
                  Retry
                </Button>
              )}
              {f.status !== 'uploading' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeFile(f.id)}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
