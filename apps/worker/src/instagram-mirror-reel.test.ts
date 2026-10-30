/**
 * Instagram mirror reel publish: container flow, PUBLISHED recheck
 * on ambiguous publish failure, and plain-language auth errors.
 */
import { describe, expect, it } from 'vitest';
import { InstagramGraphError } from './instagram-client.js';
import { MockInstagramPublishClient } from './instagram-client.js';
import {
  INSTAGRAM_MIRROR_REEL_EXPIRED_MESSAGE,
  publishInstagramMirrorReel,
} from './instagram-mirror-reel.js';

const base = {
  igUserId: 'ig_123',
  accessToken: 'ig-token',
  videoUrl: 'https://example.com/no-wm.mp4',
  caption: 'My exact caption',
  pollIntervalMs: 0,
};

describe('publishInstagramMirrorReel', () => {
  it('creates a REELS container from the video URL and publishes it', async () => {
    const client = new MockInstagramPublishClient();
    const mediaId = await publishInstagramMirrorReel({ ...base, client });
    expect(mediaId).toBe('mock_media_1');
    expect(client.containersCreated).toHaveLength(1);
    expect(client.containersCreated[0]?.mediaType).toBe('REELS');
    expect(client.containersCreated[0]?.videoUrl).toBe(base.videoUrl);
    expect(client.containersCreated[0]?.caption).toBe(base.caption);
    expect(client.containersPublished).toHaveLength(1);
  });

  it('settles published without a second publish when the container reads PUBLISHED after a publish throw', async () => {
    const client = new MockInstagramPublishClient();
    client.publishErrorToThrow = new Error('publish timed out');
    // First status read (poll) → FINISHED; the recheck after the
    // throw → PUBLISHED, so the call settles published.
    client.statusSequence = ['FINISHED', 'PUBLISHED'];
    const mediaId = await publishInstagramMirrorReel({ ...base, client });
    expect(mediaId).toBe('mock_container_1');
    expect(client.containersPublished).toHaveLength(0);
  });

  it('throws the plain expired message on an auth error, never the raw Graph text', async () => {
    const client = new MockInstagramPublishClient();
    client.throwOn = 'create';
    client.errorToThrow = new InstagramGraphError(
      'Invalid OAuth access token.',
      { message: 'Invalid OAuth access token.', code: 190 },
      400
    );
    await expect(publishInstagramMirrorReel({ ...base, client })).rejects.toThrow(
      INSTAGRAM_MIRROR_REEL_EXPIRED_MESSAGE
    );
  });

  it('fails loudly when the container errors instead of polling forever', async () => {
    const client = new MockInstagramPublishClient();
    client.statusSequence = ['ERROR'];
    await expect(publishInstagramMirrorReel({ ...base, client })).rejects.toThrow(
      'could not prepare'
    );
  });
});
