/**
 * Instagram reel publish (web immediate-post path): REELS container
 * from the resolved URL, poll to FINISHED, publish; auth failure
 * surfaces the plain expired message; an ambiguous publish failure
 * re-reads the container and settles PUBLISHED without a second
 * publish call; a container that never finishes stays pending-shaped
 * (still-preparing error for the caller to keep as pending).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  INSTAGRAM_REEL_EXPIRED_MESSAGE,
  InstagramReelError,
  publishInstagramReel,
} from '@/lib/server/instagram-reel';

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function graphError(message: string, code: number) {
  return { ok: false, status: 400, json: async () => ({ error: { message, code } }) };
}

const base = {
  igUserId: '17841400008460056',
  accessToken: 'ig-token',
  videoUrl: 'https://example.com/no-wm.mp4',
  caption: 'My exact caption',
  pollIntervalMs: 0,
  sleep: async () => {},
};

describe('publishInstagramReel', () => {
  it('creates a REELS container, polls to FINISHED, publishes, returns the media id', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'container_1' }))
      .mockResolvedValueOnce(okJson({ status_code: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(okJson({ status_code: 'FINISHED' }))
      .mockResolvedValueOnce(okJson({ id: 'ig_media_123' }));
    const mediaId = await publishInstagramReel({ ...base, fetchFn: fetchFn as never });
    expect(mediaId).toBe('ig_media_123');
    const createCall = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(createCall[0]).toContain('/17841400008460056/media');
    expect(JSON.parse(createCall[1].body)).toMatchObject({
      media_type: 'REELS',
      video_url: 'https://example.com/no-wm.mp4',
      caption: 'My exact caption',
    });
    const publishCall = fetchFn.mock.calls[3] as unknown as [string, { body: string }];
    expect(publishCall[0]).toContain('/media_publish');
    expect(JSON.parse(publishCall[1].body)).toMatchObject({ creation_id: 'container_1' });
  });

  it('settles PUBLISHED on recheck after a publish failure without publishing twice', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'container_1' }))
      .mockResolvedValueOnce(okJson({ status_code: 'FINISHED' }))
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okJson({ status_code: 'PUBLISHED' }));
    const settled = await publishInstagramReel({ ...base, fetchFn: fetchFn as never });
    expect(settled).toBe('container_1');
    const publishCalls = fetchFn.mock.calls.filter(([url]) =>
      String(url).includes('/media_publish')
    );
    expect(publishCalls).toHaveLength(1);
  });

  it('maps an auth error to the plain expired message', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(graphError('Invalid OAuth access token', 190));
    await expect(
      publishInstagramReel({ ...base, fetchFn: fetchFn as never })
    ).rejects.toMatchObject({
      message: INSTAGRAM_REEL_EXPIRED_MESSAGE,
      step: 'reel-container-create',
      code: 190,
    });
  });

  it('fails loudly when the container ends in ERROR', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'container_1' }))
      .mockResolvedValueOnce(okJson({ status_code: 'ERROR' }));
    const err = await publishInstagramReel({ ...base, fetchFn: fetchFn as never }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(InstagramReelError);
    expect((err as Error).message).toContain('could not prepare this reel');
  });

  it('reports still-preparing when the poll budget runs out', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'container_1' }))
      .mockResolvedValue(okJson({ status_code: 'IN_PROGRESS' }));
    await expect(
      publishInstagramReel({ ...base, maxPolls: 3, fetchFn: fetchFn as never })
    ).rejects.toThrow('still preparing this reel');
  });
});
