import { describe, expect, it, vi } from 'vitest';
import { SupabaseRpc, stripTrailingSlashes } from './supabase.js';
import type { FetchImpl } from './tikwm.js';

const URL = 'https://example.supabase.co';
const KEY = 'service-role-key-for-tests';

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe('SupabaseRpc', () => {
  it('claims ONLY through the TikTok RPC and validates rows', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return okJson([
        {
          reel_id: 'r1',
          config_id: 'c1',
          source_platform: 'tiktok',
          source_username: 'someone',
          source_reel_id: '123',
        },
      ]);
    }) as unknown as FetchImpl;
    const rpc = new SupabaseRpc(URL, KEY, fetchImpl);
    const rows = await rpc.claimTikTokDownloads(10);
    expect(calls).toEqual([`${URL}/rest/v1/rpc/claim_tiktok_buffer_downloads`]);
    expect(calls[0]).not.toContain('claim_adu_buffer_downloads');
    expect(rows).toEqual([
      {
        reelId: 'r1',
        configId: 'c1',
        sourcePlatform: 'tiktok',
        sourceUsername: 'someone',
        sourceReelId: '123',
      },
    ]);
  });

  it('refuses a non-TikTok row instead of processing it', async () => {
    const fetchImpl = (async () =>
      okJson([
        {
          reel_id: 'r1',
          config_id: 'c1',
          source_platform: 'instagram',
          source_username: 'someone',
          source_reel_id: '123',
        },
      ])) as unknown as FetchImpl;
    const rpc = new SupabaseRpc(URL, KEY, fetchImpl);
    await expect(rpc.claimTikTokDownloads(10)).rejects.toThrow(/non-TikTok/);
  });

  it('rejects malformed claim rows', async () => {
    const fetchImpl = (async () => okJson([{ reel_id: 'r1' }])) as unknown as FetchImpl;
    const rpc = new SupabaseRpc(URL, KEY, fetchImpl);
    await expect(rpc.claimTikTokDownloads(10)).rejects.toThrow(/invalid shape/);
  });

  it('sends the exact markDownloaded params', async () => {
    let seenBody: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string);
      return new Response(null, { status: 204 });
    }) as unknown as FetchImpl;
    const rpc = new SupabaseRpc(URL, KEY, fetchImpl);
    await rpc.markDownloaded({
      reelId: 'r1',
      objectKey: 'adu-buffer/c1/r1.mp4',
      sizeBytes: 12345,
      contentType: 'video/mp4',
      sha256: 'abc',
      caption: 'Hi',
      mediaUrl: 'https://pub.example/adu-buffer/c1/r1.mp4',
    });
    expect(seenBody).toEqual({
      p_reel_id: 'r1',
      p_media_object_key: 'adu-buffer/c1/r1.mp4',
      p_media_size_bytes: 12345,
      p_media_content_type: 'video/mp4',
      p_media_sha256: 'abc',
      p_reel_caption: 'Hi',
      p_media_url: 'https://pub.example/adu-buffer/c1/r1.mp4',
    });
  });

  it('sends the failure reason to recordDownloadFailure', async () => {
    let seenBody: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string);
      return new Response(null, { status: 204 });
    }) as unknown as FetchImpl;
    const rpc = new SupabaseRpc(URL, KEY, fetchImpl);
    await rpc.recordDownloadFailure('r1', {
      stage: 'tikwm_resolve',
      reason: 'tikwm_api_http_status',
      detail: 'http_status=403',
    });
    expect(seenBody).toMatchObject({
      p_reel_id: 'r1',
      p_failure: {
        stage: 'tikwm_resolve',
        reason: 'tikwm_api_http_status',
        detail: 'http_status=403',
      },
    });
    const failure = (seenBody as { p_failure: { at: unknown } }).p_failure;
    expect(typeof failure.at).toBe('string');
  });

  it('sends the fallback attempt inside a both-fail record', async () => {
    let seenBody: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string);
      return new Response(null, { status: 204 });
    }) as unknown as FetchImpl;
    const rpc = new SupabaseRpc(URL, KEY, fetchImpl);
    await rpc.recordDownloadFailure('r1', {
      stage: 'tikwm_resolve',
      reason: 'tikwm_api_body_code',
      detail: 'body_code=-1',
      fallback: { stage: 'countik_resolve', reason: 'countik_api_http_status', detail: 'step=exist; http_status=403' },
    });
    expect(seenBody).toMatchObject({
      p_reel_id: 'r1',
      p_failure: {
        stage: 'tikwm_resolve',
        reason: 'tikwm_api_body_code',
        detail: 'body_code=-1',
        fallback: { stage: 'countik_resolve', reason: 'countik_api_http_status', detail: 'step=exist; http_status=403' },
      },
    });
  });

  it('markDownloadFailed still sends only the reel id', async () => {
    let seenBody: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(init.body as string);
      return new Response(null, { status: 204 });
    }) as unknown as FetchImpl;
    const rpc = new SupabaseRpc(URL, KEY, fetchImpl);
    await rpc.markDownloadFailed('r1');
    expect(seenBody).toEqual({ p_reel_id: 'r1' });
  });

  it('fails loud on RPC HTTP errors without leaking the key', async () => {
    const fetchImpl = (async () => new Response('permission denied', { status: 401 })) as unknown as FetchImpl;
    const rpc = new SupabaseRpc(URL, KEY, fetchImpl);
    const err = await rpc.markDownloadFailed('r1').then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err?.message).toContain('401');
    expect(err?.message).not.toContain(KEY);
  });

  it('returns the stale-reset count and validates it', async () => {
    const good = (async () => okJson(3)) as unknown as FetchImpl;
    expect(await new SupabaseRpc(URL, KEY, good).resetStaleDownloads(40)).toBe(3);
    const bad = (async () => okJson('three')) as unknown as FetchImpl;
    await expect(new SupabaseRpc(URL, KEY, bad).resetStaleDownloads(40)).rejects.toThrow(/non-integer/);
  });

  it('requires URL and key at construction', () => {
    expect(() => new SupabaseRpc('', KEY)).toThrow();
    expect(() => new SupabaseRpc(URL, '')).toThrow();
  });
});

describe('workerd fetch binding', () => {
  // Mimics workerd's brand check on its native fetch: the call is
  // rejected unless the receiver is undefined (bare call) or the
  // global object. A stored reference invoked as `this.fetchImpl(...)`
  // binds `this` to the client and throws — exactly the production
  // failure, where every tick died on the first RPC call with
  // "Illegal invocation". Node/bun permit detached fetch, so a plain
  // mock can never catch this; the brand check is the whole point.
  function workerdBrandCheckedFetch(this: unknown, url: string): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      throw new Error('Illegal invocation: function called with incorrect `this` reference');
    }
    return Promise.resolve(okJson(0));
  }

  it('uses the default fetch wiring without a client receiver', async () => {
    vi.stubGlobal('fetch', workerdBrandCheckedFetch);
    try {
      await expect(new SupabaseRpc(URL, KEY).resetStaleDownloads(40)).resolves.toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails when a raw fetch reference is stored and method-called', async () => {
    const rpc = new SupabaseRpc(URL, KEY, workerdBrandCheckedFetch as unknown as FetchImpl);
    await expect(rpc.resetStaleDownloads(40)).rejects.toThrow(/Illegal invocation/);
  });
});

describe('stripTrailingSlashes', () => {
  it('removes all trailing slashes and leaves everything else untouched', () => {
    expect(stripTrailingSlashes('https://example.com///')).toBe('https://example.com');
    expect(stripTrailingSlashes('https://example.com/')).toBe('https://example.com');
    expect(stripTrailingSlashes('https://example.com')).toBe('https://example.com');
    expect(stripTrailingSlashes('https://example.com/a/b/')).toBe('https://example.com/a/b');
    expect(stripTrailingSlashes('')).toBe('');
    expect(stripTrailingSlashes('///')).toBe('');
  });
});
