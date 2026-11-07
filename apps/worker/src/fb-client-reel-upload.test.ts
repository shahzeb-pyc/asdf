/**
 * Reel upload via `file_url` (primary) with streaming fallback.
 *
 * `publishReel` must send the hosted file URL to rupload first so
 * Facebook fetches the file itself (no video bytes through the worker),
 * and only stream the bytes when that attempt fails — against a fresh
 * upload session. Failures must carry the failing phase, HTTP status,
 * and Facebook's raw body, never just code `unknown`.
 *
 * All Facebook / media endpoints are mocked through `fetchFn`; no
 * network, no real Facebook, no tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalError } from '@fbuploadpro/contracts';
import { FacebookGraphError, FacebookPublishClient } from './fb-client.js';

const PAGE_ID = '110103338715385';
const TOKEN = 'page-token';
const MEDIA_URL = 'https://media.test/windy-laundry.mp4';
const CAPTION = 'Windy Laundry';
const ITEM_ID = 'eaf2d33a-d13a-4a8d-844c-555e910f1c0f';
const RUPLOAD = 'https://rupload.facebook.com/video-upload/v27.0';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

interface UploadScenario {
  fileUrl: () => Response;
  stream: () => Response;
  finish?: () => Response;
  /** Overrides the start response for a given start count (1-based). */
  start?: (count: number) => Response;
}

/** A timeout throw, as AbortSignal.timeout produces it in production. */
function abortError(): Error {
  const err = new Error('The operation timed out');
  err.name = 'AbortError';
  return err;
}

function makeClient(scenario: UploadScenario): {
  client: FacebookPublishClient;
  calls: RecordedCall[];
  startCount: () => number;
} {
  const calls: RecordedCall[] = [];
  let startCount = 0;

  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    if (rawHeaders) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers[key.toLowerCase()] = String(value);
      }
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({ url, method: init?.method ?? 'GET', headers, body });

    if (url === MEDIA_URL) {
      return new Response('fake-video-bytes', {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      });
    }
    if (url.includes('/video_reels')) {
      const parsed = body ? (JSON.parse(body) as { upload_phase?: string }) : {};
      if (parsed.upload_phase === 'start') {
        startCount += 1;
        if (scenario.start) return scenario.start(startCount);
        return jsonResponse({
          video_id: `vid-${startCount}`,
          upload_url: `${RUPLOAD}/vid-${startCount}`,
        });
      }
      if (parsed.upload_phase === 'finish') {
        return scenario.finish ? scenario.finish() : jsonResponse({ success: true, post_id: 'post-123' });
      }
    }
    if (url.startsWith(RUPLOAD)) {
      if (headers['file_url'] !== undefined) return scenario.fileUrl();
      return scenario.stream();
    }
    throw new InternalError(`unexpected fetch: ${url}`);
  };

  return {
    client: new FacebookPublishClient({ fetchFn }),
    calls,
    startCount: () => startCount,
  };
}

function publish(client: FacebookPublishClient, itemId?: string): Promise<{ postId: string }> {
  return client.publishReel({
    pageId: PAGE_ID,
    accessToken: TOKEN,
    videoUrl: MEDIA_URL,
    caption: CAPTION,
    ...(itemId !== undefined ? { itemId } : {}),
  });
}

describe('publishReel file_url primary', () => {
  it('uploads via file_url: Facebook fetches the file, bytes are never fetched', async () => {
    const { client, calls, startCount } = makeClient({
      fileUrl: () => jsonResponse({ success: true }),
      stream: () => {
        throw new InternalError('streaming must not run when file_url succeeds');
      },
    });

    const result = await publish(client);

    expect(result.postId).toBe('post-123');
    expect(startCount()).toBe(1);
    // The media URL is never fetched: no bytes pass through the worker.
    expect(calls.some((call) => call.url === MEDIA_URL)).toBe(false);
    const uploadCalls = calls.filter((call) => call.url.startsWith(RUPLOAD));
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]?.headers['file_url']).toBe(MEDIA_URL);
    expect(uploadCalls[0]?.headers['offset']).toBeUndefined();
    const finishCall = calls.find((call) => call.body?.includes('"upload_phase":"finish"'));
    expect(finishCall?.body).toContain('"video_id":"vid-1"');
  });

  it('falls back to streaming once, on a fresh session, when file_url fails', async () => {
    const { client, calls, startCount } = makeClient({
      fileUrl: () =>
        jsonResponse(
          {
            error: {
              message: 'The file could not be fetched (fileurlprocessingerror)',
              code: 100,
            },
          },
          400
        ),
      stream: () => jsonResponse({ success: true }),
    });

    const result = await publish(client);

    expect(result.postId).toBe('post-123');
    // One failed file_url attempt, then a fresh start for the stream.
    expect(startCount()).toBe(2);
    const uploadCalls = calls.filter((call) => call.url.startsWith(RUPLOAD));
    expect(uploadCalls).toHaveLength(2);
    expect(uploadCalls[0]?.headers['file_url']).toBe(MEDIA_URL);
    expect(uploadCalls[1]?.headers['offset']).toBe('0');
    expect(uploadCalls[1]?.url).toContain('/vid-2');
    // The streamed bytes came from the media URL, fetched once.
    expect(calls.filter((call) => call.url === MEDIA_URL)).toHaveLength(1);
    const finishCall = calls.find((call) => call.body?.includes('"upload_phase":"finish"'));
    expect(finishCall?.body).toContain('"video_id":"vid-2"');
  });

  it('falls back to streaming on a fresh session when the file_url attempt throws', async () => {
    const { client, calls, startCount } = makeClient({
      fileUrl: () => {
        throw abortError();
      },
      stream: () => jsonResponse({ success: true }),
    });

    const result = await publish(client);

    expect(result.postId).toBe('post-123');
    // The throw is a failed attempt, not a skipped fallback: a fresh
    // start runs and the stream succeeds on the fresh session.
    expect(startCount()).toBe(2);
    const streamCalls = calls.filter(
      (call) => call.url.startsWith(RUPLOAD) && call.headers['offset'] === '0'
    );
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.url).toContain('/vid-2');
    // The streamed bytes came from the media URL, fetched once.
    expect(calls.filter((call) => call.url === MEDIA_URL)).toHaveLength(1);
    const finishCall = calls.find((call) => call.body?.includes('"upload_phase":"finish"'));
    expect(finishCall?.body).toContain('"video_id":"vid-2"');
    // 10s timeout: fetchWithRetry replays the throwing file_url call 3x
    // with 1s + 2s backoff before the throw surfaces.
  }, 10_000);

  it('names both attempts when the file_url attempt throws and streaming fails body-less', async () => {
    const { client } = makeClient({
      fileUrl: () => {
        throw abortError();
      },
      stream: () => emptyResponse(400),
    });

    let caught: unknown;
    try {
      await publish(client);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FacebookGraphError);
    const graphError = caught as FacebookGraphError;
    expect(graphError.message).toContain('(reel-upload-stream)');
    expect(graphError.diagnostic?.phase).toBe('reel-upload-stream');
    expect(graphError.diagnostic?.httpStatus).toBe(400);
    expect(graphError.diagnostic?.rawBody).toBe('');
    expect(graphError.diagnostic?.attempts).toEqual([
      { mode: 'file_url', success: false, message: 'The operation timed out' },
      { mode: 'stream', success: false, httpStatus: 400, rawBody: '' },
    ]);
    // 10s timeout: fetchWithRetry replays the throwing file_url call 3x
    // with 1s + 2s backoff before the throw surfaces.
  }, 10_000);

  it('keeps the file_url attempt when the fresh-session start for the fallback fails', async () => {
    const { client } = makeClient({
      fileUrl: () => emptyResponse(400),
      stream: () => {
        throw new InternalError('streaming must not run when the fresh start fails');
      },
      start: (count) =>
        count === 2
          ? emptyResponse(400)
          : jsonResponse({
              video_id: `vid-${count}`,
              upload_url: `${RUPLOAD}/vid-${count}`,
            }),
    });

    let caught: unknown;
    try {
      await publish(client);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FacebookGraphError);
    const graphError = caught as FacebookGraphError;
    expect(graphError.diagnostic?.phase).toBe('reel-start');
    expect(graphError.diagnostic?.httpStatus).toBe(400);
    expect(graphError.diagnostic?.rawBody).toBe('');
    expect(graphError.diagnostic?.attempts).toEqual([
      { mode: 'file_url', success: false, httpStatus: 400, rawBody: '' },
    ]);
  });

  it('names both attempts when file_url and streaming both fail body-less', async () => {
    const { client } = makeClient({
      fileUrl: () => emptyResponse(400),
      stream: () => emptyResponse(400),
    });

    let caught: unknown;
    try {
      await publish(client);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FacebookGraphError);
    const graphError = caught as FacebookGraphError;
    expect(graphError.message).toContain('(reel-upload-stream)');
    expect(graphError.diagnostic?.phase).toBe('reel-upload-stream');
    expect(graphError.diagnostic?.httpStatus).toBe(400);
    expect(graphError.diagnostic?.rawBody).toBe('');
    expect(graphError.diagnostic?.attempts).toEqual([
      { mode: 'file_url', success: false, httpStatus: 400, rawBody: '' },
      { mode: 'stream', success: false, httpStatus: 400, rawBody: '' },
    ]);
  });

  it('carries phase, status, and empty raw body on a body-less finish 400', async () => {
    const { client } = makeClient({
      fileUrl: () => jsonResponse({ success: true }),
      stream: () => {
        throw new InternalError('streaming must not run when file_url succeeds');
      },
      finish: () => emptyResponse(400),
    });

    let caught: unknown;
    try {
      await publish(client);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FacebookGraphError);
    const graphError = caught as FacebookGraphError;
    expect(graphError.message).toContain('(reel-finish)');
    expect(graphError.diagnostic?.phase).toBe('reel-finish');
    expect(graphError.diagnostic?.httpStatus).toBe(400);
    expect(graphError.diagnostic?.rawBody).toBe('');
  });
});

describe('publishReel Cloudflare console logging', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function lines(spy: ReturnType<typeof vi.spyOn>): string[] {
    return spy.mock.calls.map((call: unknown[]) => String(call[0] ?? ''));
  }

  it('logs one info line with mode=file_url on success, and nothing else', async () => {
    const { client } = makeClient({
      fileUrl: () => jsonResponse({ success: true }),
      stream: () => {
        throw new InternalError('streaming must not run when file_url succeeds');
      },
    });

    const result = await publish(client, ITEM_ID);

    expect(result.postId).toBe('post-123');
    expect(lines(infoSpy)).toEqual([
      `[reel-publish] item=${ITEM_ID} page=${PAGE_ID} published mode=file_url post=post-123`,
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns on the file_url failure and logs mode=stream on the fallback success', async () => {
    const { client } = makeClient({
      fileUrl: () =>
        jsonResponse(
          {
            error: {
              message: 'The file could not be fetched (fileurlprocessingerror)',
              code: 100,
            },
          },
          400
        ),
      stream: () => jsonResponse({ success: true }),
    });

    const result = await publish(client, ITEM_ID);

    expect(result.postId).toBe('post-123');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnLine = lines(warnSpy)[0] ?? '';
    expect(warnLine).toContain(`[reel-publish] item=${ITEM_ID} page=${PAGE_ID}`);
    expect(warnLine).toContain('file_url upload failed');
    expect(warnLine).toContain('status=400');
    expect(warnLine).toContain('fileurlprocessingerror');
    expect(warnLine).toContain('falling back to streaming');
    expect(lines(infoSpy)).toEqual([
      `[reel-publish] item=${ITEM_ID} page=${PAGE_ID} published mode=stream post=post-123`,
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs exactly one error line naming both attempts when both uploads fail', async () => {
    const { client } = makeClient({
      fileUrl: () => emptyResponse(400),
      stream: () => emptyResponse(400),
    });

    await expect(publish(client, ITEM_ID)).rejects.toBeInstanceOf(FacebookGraphError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const errorLine = lines(errorSpy)[0] ?? '';
    expect(errorLine).toContain(`[reel-publish] item=${ITEM_ID} page=${PAGE_ID} failed`);
    expect(errorLine).toContain('phase=reel-upload-stream');
    expect(errorLine).toContain('status=400');
    expect(errorLine).toContain('attempts=[file_url:400,stream:400]');
    expect(errorLine).not.toContain('\n');
    expect(errorLine).not.toContain(TOKEN);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('logs one error line with phase=reel-finish on a body-less finish 400', async () => {
    const { client } = makeClient({
      fileUrl: () => jsonResponse({ success: true }),
      stream: () => {
        throw new InternalError('streaming must not run when file_url succeeds');
      },
      finish: () => emptyResponse(400),
    });

    await expect(publish(client, ITEM_ID)).rejects.toBeInstanceOf(FacebookGraphError);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const errorLine = lines(errorSpy)[0] ?? '';
    expect(errorLine).toContain(`[reel-publish] item=${ITEM_ID} page=${PAGE_ID} failed`);
    expect(errorLine).toContain('phase=reel-finish');
    expect(errorLine).toContain('status=400');
    expect(errorLine).not.toContain('\n');
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
