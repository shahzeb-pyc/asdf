import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  FacebookPublishClient,
  FacebookGraphError,
  FB_GRAPH_TIMEOUT_MS,
  FB_MEDIA_TIMEOUT_MS,
  parseGraphRateLimitHeaders,
} from '../src/fb-client.js';
import { MockFacebookPublishClient } from './mock-fb-client.js';

describe('FacebookPublishClient', () => {
  const pageId = 'page_12345';
  const accessToken = 'EAA_test_token_secret';
  const videoUrl = 'https://r2.example.com/videos/reel-1.mp4';
  const imageUrl = 'https://r2.example.com/images/photo-1.jpg';
  const caption = 'Check out this awesome video! #viral';
  const firstComment = 'Follow our page for daily updates!';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('default fetch binding (workerd receiver check)', () => {
    it('publishes through the default fetch even when the runtime brand-checks fetch', async () => {
      const originalFetch = globalThis.fetch;
      const seenReceivers: unknown[] = [];
      function workerdLikeFetch(
        this: unknown,
        _input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> {
        seenReceivers.push(this);
        // Mimic workerd: native fetch rejects any receiver that is
        // neither a bare call (undefined under strict mode) nor
        // globalThis. Pre-fix code calls the stored fetch as a method
        // on the client, so this test fails on pre-fix code.
        if (this !== undefined && this !== globalThis) {
          throw new TypeError(
            'Illegal invocation: function called with incorrect `this` reference.',
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ id: `${pageId}_post_999` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      globalThis.fetch = workerdLikeFetch as unknown as typeof fetch;
      try {
        // No fetchFn injected: the client must use the default fetch path.
        const client = new FacebookPublishClient();
        const result = await client.publishTextPost({
          pageId,
          accessToken,
          message: 'hello',
        });
        expect(result.postId).toBe(`${pageId}_post_999`);
        expect(seenReceivers.length).toBeGreaterThan(0);
        for (const receiver of seenReceivers) {
          expect(receiver === undefined || receiver === globalThis).toBe(true);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('publishReel (3-phase session)', () => {
    it('executes start, stream upload, and finish phases successfully', async () => {
      const mockFetch = vi.fn();

      // Phase 1: start upload session
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            video_id: 'vid_98765',
            upload_url: 'https://rupload.facebook.com/video-reels/vid_98765',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      // Phase 2: fetch video binary stream from videoUrl
      const fakeVideoBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('fake-binary-data'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(
        new Response(fakeVideoBody, {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        })
      );

      // Phase 2: upload binary stream to rupload
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      // Phase 3: finish upload and publish reel
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            post_id: `${pageId}_post_555`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const result = await client.publishReel({
        pageId,
        accessToken,
        videoUrl,
        caption,
      });

      expect(result).toEqual({ postId: `${pageId}_post_555` });

      expect(mockFetch).toHaveBeenCalledTimes(4);

      // 1. Phase 1 call
      const [startUrl, startInit] = mockFetch.mock.calls[0];
      expect(startUrl).toBe(`https://graph.facebook.com/v26.0/${pageId}/video_reels`);
      expect(startInit.method).toBe('POST');
      expect(startInit.headers.Authorization).toBe(`Bearer ${accessToken}`);
      expect(JSON.parse(startInit.body)).toEqual({ upload_phase: 'start' });

      // 2. Fetch video binary
      const [fetchVideoUrl] = mockFetch.mock.calls[1];
      expect(fetchVideoUrl).toBe(videoUrl);

      // 3. Phase 2 call (upload stream)
      const [uploadUrl, uploadInit] = mockFetch.mock.calls[2];
      expect(uploadUrl).toBe('https://rupload.facebook.com/video-reels/vid_98765');
      expect(uploadInit.method).toBe('POST');
      expect(uploadInit.headers.Authorization).toBe(`OAuth ${accessToken}`);
      expect(uploadInit.headers.offset).toBe('0');
      expect(uploadInit.headers['Content-Type']).toBe('application/octet-stream');

      // 4. Phase 3 call (finish)
      const [finishUrl, finishInit] = mockFetch.mock.calls[3];
      expect(finishUrl).toBe(`https://graph.facebook.com/v26.0/${pageId}/video_reels`);
      expect(finishInit.method).toBe('POST');
      expect(finishInit.headers.Authorization).toBe(`Bearer ${accessToken}`);
      expect(JSON.parse(finishInit.body)).toEqual({
        upload_phase: 'finish',
        video_state: 'PUBLISHED',
        description: caption,
        video_id: 'vid_98765',
      });
    });

    it('falls back to video_id if post_id is not in finish response', async () => {
      const mockFetch = vi.fn();
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              video_id: 'vid_98765',
              upload_url: 'https://rupload.facebook.com/video-reels/vid_98765',
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('video-data', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const result = await client.publishReel({ pageId, accessToken, videoUrl, caption });
      expect(result).toEqual({ postId: 'vid_98765' });
    });

    it('throws error when video source fetch fails in Phase 2', async () => {
      const mockFetch = vi.fn();
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              video_id: 'vid_98765',
              upload_url: 'https://rupload.facebook.com/video-reels/vid_98765',
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response(null, { status: 404, statusText: 'Not Found' }));

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      await expect(
        client.publishReel({ pageId, accessToken, videoUrl, caption })
      ).rejects.toThrow(/Failed to fetch video/i);
    });
  });

  describe('publishPhoto', () => {
    it('executes photo upload POST to Graph API with published=true', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'photo_999',
            post_id: `${pageId}_photo_999`,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const result = await client.publishPhoto({
        pageId,
        accessToken,
        imageUrl,
        caption,
      });

      expect(result).toEqual({ postId: `${pageId}_photo_999` });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://graph.facebook.com/v26.0/${pageId}/photos`);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${accessToken}`);
      expect(JSON.parse(init.body)).toEqual({
        url: imageUrl,
        caption,
        published: true,
      });
    });

    it('falls back to id if post_id is not present in response', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'photo_only_id' }), { status: 200 })
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const result = await client.publishPhoto({
        pageId,
        accessToken,
        imageUrl,
        caption,
      });

      expect(result).toEqual({ postId: 'photo_only_id' });
    });
  });

  describe('postComment', () => {
    it('posts first comment to Graph API comment endpoint', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'comment_abc123',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const result = await client.postComment({
        postId: `${pageId}_post_555`,
        accessToken,
        message: firstComment,
      });

      expect(result).toEqual({ commentId: 'comment_abc123' });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://graph.facebook.com/v26.0/${pageId}_post_555/comments`);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe(`Bearer ${accessToken}`);
      expect(JSON.parse(init.body)).toEqual({
        message: firstComment,
      });
    });
  });

  describe('Graph API error handling', () => {
    it('throws FacebookGraphError on invalid token (code 190)', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'Error validating access token: Session has expired.',
              type: 'OAuthException',
              code: 190,
              error_subcode: 463,
              fbtrace_id: 'abc_trace_190',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });

      let thrownError: unknown = null;
      try {
        await client.publishReel({ pageId, accessToken, videoUrl, caption });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(FacebookGraphError);
      const graphError = thrownError as FacebookGraphError;
      expect(graphError.code).toBe(190);
      expect(graphError.isAuthError).toBe(true);
      expect(graphError.isRateLimit).toBe(false);
      expect(graphError.fbtraceId).toBe('abc_trace_190');
      expect(graphError.message).toContain('Error validating access token');
    });

    it('throws FacebookGraphError on rate limit error (code 368)', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: 'It looks like you were misusing this feature by going too fast. You’ve been temporarily blocked from using it.',
              type: 'OAuthException',
              code: 368,
              fbtrace_id: 'abc_trace_368',
            },
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });

      let thrownError: unknown = null;
      try {
        await client.publishPhoto({ pageId, accessToken, imageUrl, caption });
      } catch (err) {
        thrownError = err;
      }

      expect(thrownError).toBeInstanceOf(FacebookGraphError);
      const graphError = thrownError as FacebookGraphError;
      expect(graphError.code).toBe(368);
      expect(graphError.isRateLimit).toBe(true);
      expect(graphError.isAuthError).toBe(false);
    });

    it('throws FacebookGraphError on comment endpoint error', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'Unsupported post request. Object with ID does not exist.',
              type: 'GraphMethodException',
              code: 100,
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });

      await expect(
        client.postComment({ postId: 'invalid_id', accessToken, message: 'test' })
      ).rejects.toThrow(FacebookGraphError);
    });

    it('identifies rate limit codes 4, 17, 32, and 613', () => {
      for (const code of [4, 17, 32, 368, 613]) {
        const err = new FacebookGraphError('Rate limit exceeded', {
          message: 'Rate limit exceeded',
          code,
        });
        expect(err.isRateLimit).toBe(true);
        expect(err.isAuthError).toBe(false);
      }
    });

    it('identifies permanent client errors (code 100 and 4xx client errors)', () => {
      const err100 = new FacebookGraphError('Invalid parameter', {
        message: 'Invalid parameter',
        code: 100,
      });
      expect(err100.isPermanentClientError).toBe(true);
      expect(err100.isAuthError).toBe(false);
      expect(err100.isRateLimit).toBe(false);

      const err400 = new FacebookGraphError('Bad request', {
        message: 'Bad request',
        code: 400,
      });
      expect(err400.isPermanentClientError).toBe(true);

      const err404 = new FacebookGraphError('Object not found', {
        message: 'Object not found',
        code: 404,
      });
      expect(err404.isPermanentClientError).toBe(true);

      const authErr = new FacebookGraphError('Session expired', {
        message: 'Session expired',
        code: 190,
      });
      expect(authErr.isPermanentClientError).toBe(false);
      expect(authErr.isAuthError).toBe(true);
    });

    it('throws error when start session response is missing video_id or upload_url', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      await expect(
        client.publishReel({ pageId, accessToken, videoUrl, caption })
      ).rejects.toThrow(/missing video_id or upload_url/i);
    });

    it('throws error when binary upload fails in Phase 2', async () => {
      const mockFetch = vi.fn();
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              video_id: 'vid_123',
              upload_url: 'https://rupload.facebook.com/video-reels/vid_123',
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(new Response('binary', { status: 200 }))
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { message: 'Transfer aborted', code: 500 },
            }),
            { status: 500 }
          )
        );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      await expect(
        client.publishReel({ pageId, accessToken, videoUrl, caption })
      ).rejects.toThrow(/Transfer aborted/i);
    });

    it('throws error when photo response is missing id or post_id', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      await expect(
        client.publishPhoto({ pageId, accessToken, imageUrl, caption })
      ).rejects.toThrow(/missing id\/post_id/i);
    });

    it('throws error when comment response is missing id', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      await expect(
        client.postComment({ postId: 'p1', accessToken, message: 'm1' })
      ).rejects.toThrow(/missing id/i);
    });

    it('trims trailing slashes from custom baseUrl', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'p123' }), { status: 200 })
      );

      const client = new FacebookPublishClient({
        baseUrl: 'https://custom-graph.facebook.com/v26.0/',
        fetchFn: mockFetch,
      });

      await client.publishPhoto({ pageId, accessToken, imageUrl, caption });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom-graph.facebook.com/v26.0/page_12345/photos',
        expect.anything()
      );
    });
  });

  describe('MockFacebookPublishClient', () => {
    it('records published items and returns mock IDs', async () => {
      const mockClient = new MockFacebookPublishClient();

      const reelResult = await mockClient.publishReel({
        pageId,
        accessToken,
        videoUrl,
        caption,
      });
      expect(reelResult).toEqual({ postId: 'mock_post_123' });
      expect(mockClient.reelsPublished).toHaveLength(1);
      expect(mockClient.reelsPublished[0].pageId).toBe(pageId);

      const photoResult = await mockClient.publishPhoto({
        pageId,
        accessToken,
        imageUrl,
        caption,
      });
      expect(photoResult).toEqual({ postId: 'mock_post_123' });
      expect(mockClient.photosPublished).toHaveLength(1);

      const commentResult = await mockClient.postComment({
        postId: reelResult.postId,
        accessToken,
        message: firstComment,
      });
      expect(commentResult).toEqual({ commentId: 'mock_comment_456' });
      expect(mockClient.commentsPosted).toHaveLength(1);

      mockClient.reset();
      expect(mockClient.reelsPublished).toHaveLength(0);
      expect(mockClient.photosPublished).toHaveLength(0);
      expect(mockClient.commentsPosted).toHaveLength(0);
    });

    it('throws error when errorToThrow is configured', async () => {
      const mockClient = new MockFacebookPublishClient();
      mockClient.errorToThrow = new Error('Simulated Meta API failure');

      await expect(
        mockClient.publishReel({ pageId, accessToken, videoUrl, caption })
      ).rejects.toThrow('Simulated Meta API failure');

      await expect(
        mockClient.publishPhoto({ pageId, accessToken, imageUrl, caption })
      ).rejects.toThrow('Simulated Meta API failure');

      await expect(
        mockClient.postComment({ postId: 'p1', accessToken, message: 'm1' })
      ).rejects.toThrow('Simulated Meta API failure');
    });

    it('records published text posts, videos, and stories in tracking arrays', async () => {
      const mockClient = new MockFacebookPublishClient();

      const textRes = await mockClient.publishTextPost({
        pageId,
        accessToken,
        message: 'Status update',
        linkUrl: 'https://example.com',
      });
      expect(textRes).toEqual({ postId: 'mock_post_123' });
      expect(mockClient.textPostsPublished).toHaveLength(1);
      expect(mockClient.textPostsPublished[0]).toEqual({
        pageId,
        message: 'Status update',
        linkUrl: 'https://example.com',
      });

      const videoRes = await mockClient.publishVideo({
        pageId,
        accessToken,
        videoUrl,
        caption: 'Video caption',
        title: 'Video Title',
      });
      expect(videoRes).toEqual({ postId: 'mock_post_123' });
      expect(mockClient.videosPublished).toHaveLength(1);
      expect(mockClient.videosPublished[0].caption).toBe('Video caption');

      const photoStoryRes = await mockClient.publishPhotoStory({
        pageId,
        accessToken,
        imageUrl,
      });
      expect(photoStoryRes).toEqual({ postId: 'mock_post_123' });
      expect(mockClient.photoStoriesPublished).toHaveLength(1);

      const videoStoryRes = await mockClient.publishVideoStory({
        pageId,
        accessToken,
        videoUrl,
      });
      expect(videoStoryRes).toEqual({ postId: 'mock_post_123' });
      expect(mockClient.videoStoriesPublished).toHaveLength(1);

      mockClient.reset();
      expect(mockClient.textPostsPublished).toHaveLength(0);
      expect(mockClient.videosPublished).toHaveLength(0);
      expect(mockClient.photoStoriesPublished).toHaveLength(0);
      expect(mockClient.videoStoriesPublished).toHaveLength(0);
    });
  });

  describe('Multi-Format Publishers in FacebookPublishClient (Spec 042)', () => {
    it('publishes text post via POST /{pageId}/feed with message and link', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ id: `${pageId}_112233` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const res = await client.publishTextPost({
        pageId,
        accessToken,
        message: 'Exciting announcement!',
        linkUrl: 'https://example.com/announcement',
      });

      expect(res.postId).toBe(`${pageId}_112233`);
      expect(mockFetch).toHaveBeenCalledWith(
        `https://graph.facebook.com/v26.0/${pageId}/feed`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            message: 'Exciting announcement!',
            link: 'https://example.com/announcement',
          }),
        })
      );
    });

    it('publishes standard feed video via POST /{pageId}/videos', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'video_id_9988' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const res = await client.publishVideo({
        pageId,
        accessToken,
        videoUrl,
        caption: 'Full length tutorial',
        title: 'Tutorial 101',
      });

      expect(res.postId).toBe('video_id_9988');
      expect(mockFetch).toHaveBeenCalledWith(
        `https://graph.facebook.com/v26.0/${pageId}/videos`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            file_url: videoUrl,
            description: 'Full length tutorial',
            title: 'Tutorial 101',
          }),
        })
      );
    });

    it('publishes photo story via 2-phase API (unpublished photo -> photo story)', async () => {
      const mockFetch = vi.fn();
      // Step 1: upload unpublished photo
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'photo_temp_123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      // Step 2: publish photo story
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'story_post_456', post_id: 'story_post_456' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const res = await client.publishPhotoStory({
        pageId,
        accessToken,
        imageUrl,
      });

      expect(res.postId).toBe('story_post_456');
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Phase 1 verification
      expect(mockFetch.mock.calls[0][0]).toBe(`https://graph.facebook.com/v26.0/${pageId}/photos`);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        url: imageUrl,
        published: false,
      });

      // Phase 2 verification
      expect(mockFetch.mock.calls[1][0]).toBe(`https://graph.facebook.com/v26.0/${pageId}/photo_stories`);
      expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({
        photo_id: 'photo_temp_123',
      });
    });

    it('publishes video story via 3-phase API (start -> rupload -> finish)', async () => {
      const mockFetch = vi.fn();
      // Phase 1: start video story session
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            video_id: 'vid_story_789',
            upload_url: 'https://rupload.facebook.com/video-stories/vid_story_789',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      // Phase 2: fetch remote video binary stream
      const fakeVideoBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('fake-binary-story-data'));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(
        new Response(fakeVideoBody, {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        })
      );
      // Phase 2: upload binary stream to rupload
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      // Phase 3: finish video story
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            post_id: 'vid_story_post_111',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const res = await client.publishVideoStory({
        pageId,
        accessToken,
        videoUrl,
      });

      expect(res.postId).toBe('vid_story_post_111');
      expect(mockFetch).toHaveBeenCalledTimes(4);

      // Phase 1: start
      expect(mockFetch.mock.calls[0][0]).toBe(`https://graph.facebook.com/v26.0/${pageId}/video_stories`);
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ upload_phase: 'start' });

      // Phase 3: finish
      expect(mockFetch.mock.calls[3][0]).toBe(`https://graph.facebook.com/v26.0/${pageId}/video_stories`);
      expect(JSON.parse(mockFetch.mock.calls[3][1].body)).toEqual({
        upload_phase: 'finish',
        video_id: 'vid_story_789',
      });
    });

    it('throws FacebookGraphError when video story start response is missing video_id', async () => {
      const mockFetch = vi.fn();
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const err = await client
        .publishVideoStory({ pageId, accessToken, videoUrl })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FacebookGraphError);
      expect((err as Error).message).toMatch(/missing video_id/i);
    });
  });

  describe('Rate Limit Header Telemetry (parseGraphRateLimitHeaders)', () => {
    it('parses X-App-Usage and X-Business-Use-Case-Usage correctly', () => {
      const headers = new Headers();
      headers.set('x-app-usage', JSON.stringify({ call_count: 45, total_cputime: 60, total_time: 30 }));
      headers.set(
        'x-business-use-case-usage',
        JSON.stringify({
          page_12345: [
            {
              call_count: 88,
              total_cputime: 75,
              total_time: 50,
              estimated_time_to_regain_access: 15,
            },
          ],
        })
      );

      const telemetry = parseGraphRateLimitHeaders(headers);
      expect(telemetry).toBeDefined();
      expect(telemetry?.appUsageMaxPct).toBe(60);
      expect(telemetry?.bucUsageMaxPct).toBe(88);
      expect(telemetry?.estimatedTimeToRegainAccessMinutes).toBe(15);
    });

    it('returns undefined when rate-limit headers are not present', () => {
      const headers = new Headers();
      expect(parseGraphRateLimitHeaders(headers)).toBeUndefined();
      expect(parseGraphRateLimitHeaders(null)).toBeUndefined();
    });
  });
});

// ==========================================
// Spec 139 — per-call retry policy + fetch timeouts
// ==========================================

describe('FacebookPublishClient — retry policy & timeouts (spec 139)', () => {
  const pageId = 'page_12345';
  const accessToken = 'EAA_test_token_secret';
  const videoUrl = 'https://r2.example.com/videos/reel-1.mp4';
  const imageUrl = 'https://r2.example.com/images/photo-1.jpg';
  const caption = 'Check out this awesome video! #viral';

  const serverError = () =>
    new Response(JSON.stringify({ error: { message: 'internal boom', code: 500 } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });

  it('does NOT retry a publish POST on a 5xx (the response may have been lost after Facebook processed it)', async () => {
    const mockFetch = vi.fn().mockImplementation(() => Promise.resolve(serverError()));
    const client = new FacebookPublishClient({ fetchFn: mockFetch });

    await expect(
      client.publishPhoto({ pageId, accessToken, imageUrl, caption })
    ).rejects.toThrow(/internal boom/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a publish POST on a network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed: socket closed'));
    const client = new FacebookPublishClient({ fetchFn: mockFetch });

    await expect(
      client.publishTextPost({ pageId, accessToken, message: 'hello' })
    ).rejects.toThrow(/socket closed/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a publish POST on 429', async () => {
    const mockFetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'rate limited', code: 4 } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const client = new FacebookPublishClient({ fetchFn: mockFetch });

    await expect(
      client.publishVideo({ pageId, accessToken, videoUrl, caption })
    ).rejects.toThrow(/rate limited/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry the reel finish phase (the publish-mutating step)', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            video_id: 'vid_98765',
            upload_url: 'https://rupload.facebook.com/video-reels/vid_98765',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(new Response('video-data', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockImplementation(() => Promise.resolve(serverError()));

    const client = new FacebookPublishClient({ fetchFn: mockFetch });
    await expect(client.publishReel({ pageId, accessToken, videoUrl, caption })).rejects.toThrow(
      /internal boom/
    );
    // start + media fetch + rupload + exactly ONE finish attempt
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it(
    'still retries pre-publish calls: the photo-story unpublished upload recovers after 5xx responses',
    async () => {
      const mockFetch = vi
        .fn()
        .mockImplementationOnce(() => Promise.resolve(serverError()))
        .mockImplementationOnce(() => Promise.resolve(serverError()))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'photo_temp_1' }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 'story_1', post_id: 'story_1' }), { status: 200 })
        );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const res = await client.publishPhotoStory({ pageId, accessToken, imageUrl });

      expect(res.postId).toBe('story_1');
      expect(mockFetch).toHaveBeenCalledTimes(4);
      // The first three calls are all the same pre-publish (published:false) upload.
      for (const call of mockFetch.mock.calls.slice(0, 3)) {
        expect(call[0]).toBe(`https://graph.facebook.com/v26.0/${pageId}/photos`);
        expect(JSON.parse(call[1].body)).toEqual({ url: imageUrl, published: false });
      }
    },
    15_000
  );

  it(
    'still retries a retryable call on network errors: reel start recovers after a socket failure',
    async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('fetch failed: socket closed'))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              video_id: 'vid_98765',
              upload_url: 'https://rupload.facebook.com/video-reels/vid_98765',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(new Response('video-data', { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, post_id: 'reel_post_1' }), {
            status: 200,
          })
        );

      const client = new FacebookPublishClient({ fetchFn: mockFetch });
      const res = await client.publishReel({ pageId, accessToken, videoUrl, caption });

      expect(res.postId).toBe('reel_post_1');
      expect(mockFetch).toHaveBeenCalledTimes(5);
    },
    15_000
  );

  it('passes an AbortSignal to fetches and exposes the named default timeouts', async () => {
    expect(FB_GRAPH_TIMEOUT_MS).toBe(15_000);
    expect(FB_MEDIA_TIMEOUT_MS).toBe(30_000);

    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'p1' }), { status: 200 }));
    const client = new FacebookPublishClient({ fetchFn: mockFetch });
    await client.publishPhoto({ pageId, accessToken, imageUrl, caption });

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a hanging Graph call at the graph timeout', async () => {
    const mockFetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('fetch was called without a signal'));
            return;
          }
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    const client = new FacebookPublishClient({ fetchFn: mockFetch, graphTimeoutMs: 30 });

    const err = await client
      .publishTextPost({ pageId, accessToken, message: 'hi' })
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe('TimeoutError');
    // A publish POST is single-attempt even when the attempt times out.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it(
    'aborts a hanging media fetch at the media timeout, retrying per the retryable policy',
    async () => {
      let mediaAttempts = 0;
      const mockFetch = vi.fn((url: unknown, init?: RequestInit) => {
        if (String(url).includes('/video_reels')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                video_id: 'vid_1',
                upload_url: 'https://rupload.facebook.com/video-reels/vid_1',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
          );
        }
        mediaAttempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('fetch was called without a signal'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      });
      const client = new FacebookPublishClient({
        fetchFn: mockFetch,
        graphTimeoutMs: 1_000,
        mediaTimeoutMs: 30,
      });

      const err = await client
        .publishReel({ pageId, accessToken, videoUrl, caption })
        .catch((e: unknown) => e);
      expect((err as Error).name).toBe('TimeoutError');
      // Media fetch is retryable: all 3 attempts ran and each one timed out.
      expect(mediaAttempts).toBe(3);
    },
    15_000
  );
});
