/**
 * Countik video resolve (mirror-side helper): video/exist -> id,
 * videoinfo/<id> -> download_link + description. All HTTP is
 * mocked — no live Countik calls.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CountikVideoError,
  resolveCountikVideo,
} from '../src/domain/countik-video';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

const EXIST = 'https://countik.com/api/video/exist';
const INFO = 'https://countik.com/api/videoinfo/vid-1';

function routingFetch(exist: unknown, info?: unknown) {
  return vi.fn(async (url: string) => {
    if (url === EXIST) {
      if (exist instanceof Error) throw exist;
      return jsonResponse(exist);
    }
    if (url === INFO) {
      if (info instanceof Error) throw info;
      return jsonResponse(info);
    }
    throw new Error(`unexpected url ${url}`);
  });
}

describe('resolveCountikVideo', () => {
  it('returns download_link + description from videoinfo', async () => {
    const fetchFn = routingFetch(
      { video_id: 'vid-1' },
      { download_link: 'https://cdn.example.com/v.mp4', desc: 'A cap' }
    );
    await expect(
      resolveCountikVideo('https://www.tiktok.com/@alice/video/123', {
        fetchFn: fetchFn as never,
      })
    ).resolves.toEqual({ playUrl: 'https://cdn.example.com/v.mp4', title: 'A cap' });
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([EXIST, INFO]);
  });

  it('accepts the alternate field names for id, link, and title', async () => {
    const fetchFn = routingFetch(
      { data: { aweme_id: 'vid-1' } },
      { data: { downloadUrl: 'https://cdn.example.com/v2.mp4', title: 'Alt cap' } }
    );
    await expect(
      resolveCountikVideo('https://www.tiktok.com/@alice/video/123', {
        fetchFn: fetchFn as never,
      })
    ).resolves.toEqual({ playUrl: 'https://cdn.example.com/v2.mp4', title: 'Alt cap' });
  });

  it('fails when exist returns no video id', async () => {
    const fetchFn = routingFetch({ status: 'not found' });
    await expect(
      resolveCountikVideo('https://www.tiktok.com/@alice/video/123', {
        fetchFn: fetchFn as never,
      })
    ).rejects.toBeInstanceOf(CountikVideoError);
  });

  it('fails when videoinfo returns no download_link', async () => {
    const fetchFn = routingFetch({ video_id: 'vid-1' }, { download_link: null });
    await expect(
      resolveCountikVideo('https://www.tiktok.com/@alice/video/123', {
        fetchFn: fetchFn as never,
      })
    ).rejects.toBeInstanceOf(CountikVideoError);
  });

  it('fails generically on a non-ok response, with no provider wording', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url === EXIST) return jsonResponse({ message: 'provider says quota' }, false, 429);
      throw new Error(`unexpected url ${url}`);
    });
    const err = await resolveCountikVideo('https://www.tiktok.com/@alice/video/123', {
      fetchFn: fetchFn as never,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CountikVideoError);
    expect((err as Error).message).not.toContain('quota');
  });

  it('accepts an empty description (callers fall back to the feed title)', async () => {
    const fetchFn = routingFetch(
      { video_id: 'vid-1' },
      { download_link: 'https://cdn.example.com/v.mp4', desc: '' }
    );
    await expect(
      resolveCountikVideo('https://www.tiktok.com/@alice/video/123', {
        fetchFn: fetchFn as never,
      })
    ).resolves.toEqual({ playUrl: 'https://cdn.example.com/v.mp4', title: '' });
  });
});
