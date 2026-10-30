import { describe, expect, it, vi } from 'vitest';
import {
  FacebookReelError,
  publishFacebookReel,
} from '@/lib/server/facebook-reel';

const RESTRICTION_MESSAGE =
  'For security reasons, your account has limited access to the site for a few days.';

function graphErrorResponse(message: string, code: number, errorSubcode: number) {
  return {
    ok: false,
    status: 400,
    json: async () => ({ error: { message, code, error_subcode: errorSubcode } }),
  };
}

describe('publishFacebookReel happy path and error branches', () => {
  function okJson(body: unknown) {
    return { ok: true, status: 200, json: async () => body };
  }

  function happyFetch(finishBody: unknown) {
    return vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ video_id: 'vid1', upload_url: 'https://example.com/upload' })
      )
      .mockResolvedValueOnce({ ok: true, body: {} })
      .mockResolvedValueOnce(okJson({}))
      .mockResolvedValueOnce(okJson(finishBody));
  }

  it('publishes end to end and returns the finish post_id', async () => {
    const fetchFn = happyFetch({ post_id: 'post1' });
    const postId = await publishFacebookReel({
      pageId: '123',
      pageToken: 'tok',
      videoUrl: 'https://example.com/v.mp4',
      caption: 'cap',
      fetchFn: fetchFn as never,
    });
    expect(postId).toBe('post1');
    const finishCall = fetchFn.mock.calls[3] as unknown as [
      string,
      { body: string },
    ];
    expect(finishCall[0]).toContain('/video_reels');
    expect(JSON.parse(finishCall[1].body)).toMatchObject({
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description: 'cap',
      video_id: 'vid1',
    });
  });

  it('falls back through finish id, video_id, then the start video_id', async () => {
    const withId = happyFetch({ id: 'id9' });
    await expect(
      publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: withId as never,
      })
    ).resolves.toBe('id9');

    const withVideoId = happyFetch({ video_id: 'vid1' });
    await expect(
      publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: withVideoId as never,
      })
    ).resolves.toBe('vid1');

    const withEmpty = happyFetch({});
    await expect(
      publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: withEmpty as never,
      })
    ).resolves.toBe('vid1');
  });

  it('throws reel-finish when the finish post_id is an empty string', async () => {
    const fetchFn = happyFetch({ post_id: '' });
    let caught: unknown;
    try {
      await publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: fetchFn as never,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FacebookReelError);
    expect((caught as FacebookReelError).step).toBe('reel-finish');
  });

  it('throws reel-start when the Graph call itself fails', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('net down'));
    let caught: unknown;
    try {
      await publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: fetchFn as never,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FacebookReelError);
    const reelError = caught as FacebookReelError;
    expect(reelError.step).toBe('reel-start');
    expect(reelError.message).toBe(
      'Facebook could not complete this request. Please try again.'
    );
  });

  it('throws reel-start when the start response has no video_id or upload_url', async () => {
    for (const startBody of [{}, { video_id: 'vid1' }, { upload_url: 'https://x/upload' }]) {
      const fetchFn = vi.fn().mockResolvedValue(okJson(startBody));
      let caught: unknown;
      try {
        await publishFacebookReel({
          pageId: '123',
          pageToken: 'tok',
          videoUrl: 'https://example.com/v.mp4',
          caption: 'cap',
          fetchFn: fetchFn as never,
        });
      } catch (err) {
        caught = err;
      }
      expect((caught as FacebookReelError).step).toBe('reel-start');
    }
  });

  it('throws reel-start when the start response body is not JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    });
    let caught: unknown;
    try {
      await publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: fetchFn as never,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as FacebookReelError).step).toBe('reel-start');
  });

  it('throws media-fetch when the video fetch fails, is not ok, or has no body', async () => {
    const start = okJson({ video_id: 'vid1', upload_url: 'https://example.com/upload' });
    const cases: unknown[] = [
      vi.fn().mockResolvedValueOnce(start).mockRejectedValueOnce(new Error('net down')),
      vi
        .fn()
        .mockResolvedValueOnce(start)
        .mockResolvedValueOnce({ ok: false, status: 500 }),
      vi
        .fn()
        .mockResolvedValueOnce(start)
        .mockResolvedValueOnce({ ok: true, body: null }),
    ];
    for (const fetchFn of cases) {
      let caught: unknown;
      try {
        await publishFacebookReel({
          pageId: '123',
          pageToken: 'tok',
          videoUrl: 'https://example.com/v.mp4',
          caption: 'cap',
          fetchFn: fetchFn as never,
        });
      } catch (err) {
        caught = err;
      }
      expect((caught as FacebookReelError).step).toBe('media-fetch');
    }
  });

  it('falls back to the generic upload message when the upload error body is not JSON', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ video_id: 'vid1', upload_url: 'https://example.com/upload' })
      )
      .mockResolvedValueOnce({ ok: true, body: {} })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('bad json');
        },
      });
    let caught: unknown;
    try {
      await publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: fetchFn as never,
      });
    } catch (err) {
      caught = err;
    }
    const reelError = caught as FacebookReelError;
    expect(reelError.step).toBe('reel-upload');
    expect(reelError.httpStatus).toBe(500);
    expect(reelError.message).toBe('The reel could not be uploaded. Please try again.');
    expect(reelError.code).toBeUndefined();
  });

  it('throws reel-finish when the finish call returns a Graph error', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        okJson({ video_id: 'vid1', upload_url: 'https://example.com/upload' })
      )
      .mockResolvedValueOnce({ ok: true, body: {} })
      .mockResolvedValueOnce(okJson({}))
      .mockResolvedValueOnce(graphErrorResponse('finish broke', 1, 2424009));
    let caught: unknown;
    try {
      await publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: fetchFn as never,
      });
    } catch (err) {
      caught = err;
    }
    const reelError = caught as FacebookReelError;
    expect(reelError.step).toBe('reel-finish');
    expect(reelError.errorSubcode).toBe(2424009);
  });
});
describe('publishFacebookReel Graph error shape', () => {
  it('preserves code + subcode on a start-phase restriction error', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      graphErrorResponse(RESTRICTION_MESSAGE, 1, 2424009)
    );
    let caught: unknown;
    try {
      await publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: fetchFn as never,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FacebookReelError);
    const reelError = caught as FacebookReelError;
    expect(reelError.step).toBe('reel-start');
    expect(reelError.message).toBe(RESTRICTION_MESSAGE);
    expect(reelError.code).toBe(1);
    expect(reelError.errorSubcode).toBe(2424009);
  });

  it('preserves code + subcode on an upload-phase restriction error', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ video_id: 'vid1', upload_url: 'https://example.com/upload' }),
      })
      .mockResolvedValueOnce({ ok: true, body: {} })
      .mockResolvedValueOnce(graphErrorResponse(RESTRICTION_MESSAGE, 1, 1404078));
    let caught: unknown;
    try {
      await publishFacebookReel({
        pageId: '123',
        pageToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: fetchFn as never,
      });
    } catch (err) {
      caught = err;
    }
    const reelError = caught as FacebookReelError;
    expect(reelError.step).toBe('reel-upload');
    expect(reelError.code).toBe(1);
    expect(reelError.errorSubcode).toBe(1404078);
  });
});
