import { describe, expect, it, vi } from 'vitest';
import {
  publishThreadsVideo,
  ThreadsVideoError,
} from '@/lib/server/threads-video';

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe('publishThreadsVideo (Threads Auto Repost setup post)', () => {
  it('publishes end to end: container → FINISHED → publish, returning the media id', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'container_1' }))
      .mockResolvedValueOnce(okJson({ status: 'FINISHED' }))
      .mockResolvedValueOnce(okJson({ id: 'media_1' }));
    const mediaId = await publishThreadsVideo({
      threadsUserId: 'threads_123',
      accessToken: 'tok',
      videoUrl: 'https://example.com/v.mp4',
      caption: 'cap',
      fetchFn: fetchFn as never,
      sleep: async () => {},
    });
    expect(mediaId).toBe('media_1');
    const createCall = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(createCall[0]).toContain('/threads_123/threads');
    expect(JSON.parse(createCall[1].body)).toMatchObject({
      media_type: 'VIDEO',
      video_url: 'https://example.com/v.mp4',
      text: 'cap',
    });
    const publishCall = fetchFn.mock.calls[2] as unknown as [string, { body: string }];
    expect(publishCall[0]).toContain('/threads_publish');
    expect(JSON.parse(publishCall[1].body)).toMatchObject({ creation_id: 'container_1' });
  });

  it('polls through IN_PROGRESS before publishing on FINISHED', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'container_2' }))
      .mockResolvedValueOnce(okJson({ status: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(okJson({ status: 'FINISHED' }))
      .mockResolvedValueOnce(okJson({ id: 'media_2' }));
    const mediaId = await publishThreadsVideo({
      threadsUserId: 'threads_123',
      accessToken: 'tok',
      videoUrl: 'https://example.com/v.mp4',
      caption: 'cap',
      fetchFn: fetchFn as never,
      sleep: async () => {},
      pollIntervalMs: 0,
    });
    expect(mediaId).toBe('media_2');
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('rejects an over-long Threads caption before any fetch (never truncated)', async () => {
    const fetchFn = vi.fn();
    await expect(
      publishThreadsVideo({
        threadsUserId: 'threads_123',
        accessToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'x'.repeat(600),
        fetchFn: fetchFn as never,
        sleep: async () => {},
      })
    ).rejects.toBeInstanceOf(ThreadsVideoError);
    expect(fetchFn).not.toHaveBeenCalled();
    try {
      await publishThreadsVideo({
        threadsUserId: 'threads_123',
        accessToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'x'.repeat(600),
        fetchFn: fetchFn as never,
        sleep: async () => {},
      });
      expect.unreachable();
    } catch (err) {
      expect((err as ThreadsVideoError).step).toBe('caption');
    }
  });

  it('surfaces a container ERROR instead of publishing', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'container_3' }))
      .mockResolvedValueOnce(okJson({ status: 'ERROR', error_message: 'Video not supported' }));
    await expect(
      publishThreadsVideo({
        threadsUserId: 'threads_123',
        accessToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: fetchFn as never,
        sleep: async () => {},
      })
    ).rejects.toThrow('Video not supported');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('gives up loudly when the container never finishes', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okJson({ id: 'container_4' }))
      .mockResolvedValue(okJson({ status: 'IN_PROGRESS' }));
    await expect(
      publishThreadsVideo({
        threadsUserId: 'threads_123',
        accessToken: 'tok',
        videoUrl: 'https://example.com/v.mp4',
        caption: 'cap',
        fetchFn: fetchFn as never,
        sleep: async () => {},
        pollIntervalMs: 0,
        maxPolls: 2,
      })
    ).rejects.toThrow('still preparing');
  });
});
