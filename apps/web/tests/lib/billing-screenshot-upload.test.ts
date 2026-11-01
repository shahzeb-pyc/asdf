import { describe, expect, it, vi, beforeEach } from 'vitest';

import { uploadScreenshotFile, ScreenshotUploadError } from '@/lib/billing/screenshot-upload';
import { httpError, networkError } from '@/lib/api';

/**
 * Screenshot upload helper (submit rewrite 2026-11-01): mint a
 * presigned URL, PUT the bytes to R2, one automatic retry per step
 * on a transient failure. The mint goes through the mocked API
 * client; the PUT goes through an injected fetch.
 */

const { mockApiPost } = vi.hoisted(() => ({
  mockApiPost: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiPost: mockApiPost };
});

const MINT_RESPONSE = {
  storageKey: 'billing-screenshots/user-1/shot.png',
  uploadUrl: 'https://r2.example.com/billing-screenshots/user-1/shot.png?sig=test',
  expiresInSeconds: 900,
};

function pngFile(): File {
  return new File(['bytes'], 'proof.png', { type: 'image/png' });
}

describe('uploadScreenshotFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mints and PUTs once on the happy path and returns the key', async () => {
    mockApiPost.mockResolvedValue(MINT_RESPONSE);
    let putUrl: unknown = null;
    const put = vi.fn(async (url: unknown) => {
      putUrl = url;
      return { ok: true } as Response;
    });
    const result = await uploadScreenshotFile('acme', pngFile(), { fetchFn: put });
    expect(result.storageKey).toBe(MINT_RESPONSE.storageKey);
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(putUrl).toBe(MINT_RESPONSE.uploadUrl);
  });

  it('retries the mint once on a transient failure, then succeeds', async () => {
    mockApiPost
      .mockRejectedValueOnce(networkError(new Error('offline')))
      .mockResolvedValue(MINT_RESPONSE);
    const put = vi.fn(async () => ({ ok: true }) as Response);
    const result = await uploadScreenshotFile('acme', pngFile(), { fetchFn: put });
    expect(result.storageKey).toBe(MINT_RESPONSE.storageKey);
    expect(mockApiPost).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('does not retry the mint on a non-transient failure', async () => {
    mockApiPost.mockRejectedValue(httpError(400, 'Bad screenshot details.'));
    const put = vi.fn(async () => ({ ok: true }) as Response);
    await expect(uploadScreenshotFile('acme', pngFile(), { fetchFn: put })).rejects.toThrow(
      'Bad screenshot details.'
    );
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it('retries the PUT once on a transient failure, then succeeds', async () => {
    mockApiPost.mockResolvedValue(MINT_RESPONSE);
    const put = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValue({ ok: true } as Response);
    const result = await uploadScreenshotFile('acme', pngFile(), { fetchFn: put });
    expect(result.storageKey).toBe(MINT_RESPONSE.storageKey);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('surfaces a network PUT failure after both attempts', async () => {
    mockApiPost.mockResolvedValue(MINT_RESPONSE);
    const put = vi.fn(async () => ({ ok: false, status: 502 }) as Response);
    const error = await uploadScreenshotFile('acme', pngFile(), { fetchFn: put }).catch(
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ScreenshotUploadError);
    expect((error as ScreenshotUploadError).kind).toBe('network');
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('maps an aborted PUT to a timeout, without retry', async () => {
    mockApiPost.mockResolvedValue(MINT_RESPONSE);
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const put = vi.fn(async () => {
      throw abort;
    });
    const error = await uploadScreenshotFile('acme', pngFile(), { fetchFn: put }).catch(
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ScreenshotUploadError);
    expect((error as ScreenshotUploadError).kind).toBe('timeout');
    expect((error as ScreenshotUploadError).message).toContain('timed out');
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('maps a rejected PUT to the rejected kind, without retry', async () => {
    mockApiPost.mockResolvedValue(MINT_RESPONSE);
    const put = vi.fn(async () => ({ ok: false, status: 400 }) as Response);
    const error = await uploadScreenshotFile('acme', pngFile(), { fetchFn: put }).catch(
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ScreenshotUploadError);
    expect((error as ScreenshotUploadError).kind).toBe('rejected');
    expect(put).toHaveBeenCalledTimes(1);
  });
});
