/** @vitest-environment jsdom */
/**
 * Composer staged uploads (Create Post → Choose media → Upload from
 * device, staged mode): the first batch must start uploading
 * immediately on add, Retry must actually restart a failed file, and
 * a waiting file must show a visible state.
 *
 * Regression coverage for the 2026-11-02 owner report: a single
 * added file sat showing only its filename — no progress, no
 * "Uploaded", no error — and never became a post, because
 * `addFiles` called `runQueue()` against a ref that still held the
 * pre-update file list. The first-batch and retry tests below FAIL
 * on that code: nothing ever reaches "done", so `onSuccess` is
 * never called.
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiPostMock = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      post: (...args: unknown[]) => apiPostMock(...args),
    },
  };
});

import { ComposerStagedUpload } from '@/components/pages/dedicated/create-posts/composer-staged-upload';

type XhrOutcome = 'ok' | 'fail' | 'hold';
const xhrQueue: XhrOutcome[] = [];
const heldXhrs: Array<{
  upload: {
    onprogress:
      | ((e: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  };
  onload: (() => void) | null;
  status: number;
}> = [];

class FakeXMLHttpRequest {
  upload: {
    onprogress:
      | ((e: { lengthComputable: boolean; loaded: number; total: number }) => void)
      | null;
  } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  open() {}
  setRequestHeader() {}
  send() {
    const outcome = xhrQueue.shift() ?? 'ok';
    if (outcome === 'hold') {
      heldXhrs.push(this);
      return;
    }
    setTimeout(() => {
      if (outcome === 'ok') {
        this.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 });
        this.status = 200;
        this.onload?.();
      } else {
        this.status = 500;
        this.onload?.();
      }
    }, 0);
  }
  abort() {
    setTimeout(() => {
      this.onabort?.();
    }, 0);
  }
}

function flushHeld(ok = true) {
  const held = heldXhrs.splice(0);
  for (const xhr of held) {
    if (ok) {
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 10 });
      xhr.status = 200;
      xhr.onload?.();
    } else {
      xhr.status = 500;
      xhr.onload?.();
    }
  }
}

/** jsdom never fires image loads, so the metadata probe would hang. */
class FakeImage {
  naturalWidth = 800;
  naturalHeight = 600;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    setTimeout(() => {
      this.onload?.();
    }, 0);
  }
}

const PRESIGNED_SINGLE = {
  mediaId: '11111111-1111-4111-8111-111111111111',
  mediaKey: 'users/u/post-staging/f1.png',
  mediaUploadUrl: 'https://example.com/upload',
  thumbnailKey: 'users/u/post-staging/f1-thumb.webp',
  thumbnailUploadUrl: 'https://example.com/thumb-upload',
  publicMediaUrl: 'https://example.com/media/f1.png',
  publicThumbnailUrl: 'https://example.com/media/f1.png',
  expiresInSeconds: 900,
};

function png(name: string, size = 10) {
  return new File([new Uint8Array(size)], name, { type: 'image/png' });
}

function renderUploader(mode: 'single' | 'multi') {
  const onSuccess = vi.fn();
  const onActiveChange = vi.fn();
  render(
    <ComposerStagedUpload
      subdomain="acme"
      mode={mode}
      onSuccess={onSuccess}
      onActiveChange={onActiveChange}
    />
  );
  return { onSuccess, onActiveChange };
}

function addFiles(files: File[]) {
  const input = screen.getByTestId('media-library-device-input');
  fireEvent.change(input, { target: { files } });
}

beforeEach(() => {
  vi.clearAllMocks();
  xhrQueue.length = 0;
  heldXhrs.length = 0;
  apiPostMock.mockImplementation(async (url: string) => {
    if (url.includes('/media/upload-url')) return PRESIGNED_SINGLE;
    if (url.includes('/media/multipart/initiate')) {
      return {
        mediaId: '22222222-2222-4222-8222-222222222222',
        mediaKey: 'users/u/post-staging/big.png',
        uploadId: 'upload-1',
        publicMediaUrl: 'https://example.com/media/big.png',
        thumbnailUploadUrl: null,
        thumbnailKey: null,
        publicThumbnailUrl: null,
      };
    }
    if (url.includes('/media/multipart/part-url')) {
      return { uploadUrl: 'https://example.com/part', expiresInSeconds: 900 };
    }
    if (url.includes('/media/multipart/complete')) {
      return { key: 'users/u/post-staging/big.png' };
    }
    if (url.includes('/media/multipart/abort')) return {};
    throw new Error(`unexpected api.post ${url}`);
  });
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest);
  Object.defineProperty(URL, 'createObjectURL', {
    value: () => 'blob:test',
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: () => {},
    configurable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ComposerStagedUpload', () => {
  it('first batch: a single file starts immediately, reaches done, fires onSuccess', async () => {
    const { onSuccess } = renderUploader('single');
    addFiles([png('a.png')]);

    await screen.findByText('Uploaded');
    expect(apiPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/media/upload-url'),
      expect.anything(),
      expect.anything()
    );
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'a.png',
        source: 'staged',
        storageKey: 'users/u/post-staging/f1.png',
        captionText: 'a',
        url: 'https://example.com/media/f1.png',
      })
    );
  });

  it('retry of a failed file actually restarts its upload', async () => {
    const user = userEvent.setup();
    const { onSuccess } = renderUploader('single');
    xhrQueue.push('fail');
    addFiles([png('a.png')]);

    await screen.findByText(/Upload failed/);
    expect(onSuccess).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('Uploaded');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('a waiting file shows Waiting… while another uploads, and the picker is told', async () => {
    const { onSuccess, onActiveChange } = renderUploader('multi');
    xhrQueue.push('hold');
    addFiles([png('first.png'), png('second.png')]);

    // First file is mid-upload (Cancel only renders while uploading);
    // the second must visibly wait instead of showing a bare filename.
    await screen.findByText('Cancel');
    expect(screen.getAllByText('Waiting…')).toHaveLength(1);
    await waitFor(() =>
      expect(onActiveChange).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ name: 'first.png' }),
        1
      )
    );

    flushHeld();
    await waitFor(() =>
      expect(screen.getAllByText('Uploaded')).toHaveLength(2)
    );
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('multi batch: all files complete', async () => {
    const { onSuccess } = renderUploader('multi');
    addFiles([png('a.png'), png('b.png')]);

    await waitFor(() =>
      expect(screen.getAllByText('Uploaded')).toHaveLength(2)
    );
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });

  it('cancel stops an in-flight upload and never fires onSuccess', async () => {
    const user = userEvent.setup();
    const { onSuccess } = renderUploader('single');
    xhrQueue.push('hold');
    addFiles([png('a.png')]);

    await waitFor(() => expect(heldXhrs).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await screen.findByText('Upload cancelled.');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('oversize file is rejected without any upload attempt', async () => {
    renderUploader('single');
    const big = png('big.png');
    Object.defineProperty(big, 'size', { value: 600_000_000 });
    addFiles([big]);

    await screen.findByText('This file is larger than 500 MB.');
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('unsupported file type is rejected without any upload attempt', async () => {
    renderUploader('single');
    addFiles([new File(['x'], 'doc.pdf', { type: 'application/pdf' })]);

    await screen.findByText('This file type is not supported here.');
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('multipart over 8 MiB completes and fires onSuccess with the staged key', async () => {
    const { onSuccess } = renderUploader('single');
    addFiles([png('big.png', 8 * 1024 * 1024 + 1)]);

    await screen.findByText('Uploaded');
    expect(apiPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/media/multipart/initiate'),
      expect.anything(),
      expect.anything()
    );
    expect(apiPostMock).toHaveBeenCalledWith(
      expect.stringContaining('/media/multipart/complete'),
      expect.anything(),
      expect.anything()
    );
    expect(onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'staged',
        storageKey: 'users/u/post-staging/big.png',
      })
    );
  });
});
