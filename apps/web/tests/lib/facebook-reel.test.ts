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
