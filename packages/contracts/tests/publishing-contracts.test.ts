import { describe, it, expect } from 'vitest';
import {
  SlotTimeSchema,
  TimezoneSchema,
  CreateQueueSlotRequestSchema,
  UpdateQueueSlotRequestSchema,
  UpdateQueueScheduleTimezoneRequestSchema,
  UpdateQueueScheduleTimezoneResponseSchema,
  PageQueueSlotSchema,
  ListQueueSlotsResponseSchema,
  QueueItemStatusSchema,
  EnqueueMediaRequestSchema,
  UpdateQueueItemRequestSchema,
  QueueItemSchema,
  ListQueueItemsQuerySchema,
  ListQueueItemsResponseSchema,
  ClaimedQueueItemSchema,
  PublishLogSchema,
  ListPublishLogsQuerySchema,
  ListPublishLogsResponseSchema,
  PostFormatSchema,
  validatePostFormatEligibility,
  getEligiblePostFormatsForMedia,
} from '../src/index.js';

describe('Publishing Engine Domain Contracts', () => {
  describe('Page Queue Slots Contracts (T115)', () => {
    describe('SlotTimeSchema', () => {
      it('accepts valid HH:MM formats', () => {
        expect(SlotTimeSchema.safeParse('09:30').success).toBe(true);
        expect(SlotTimeSchema.safeParse('00:00').success).toBe(true);
        expect(SlotTimeSchema.safeParse('23:59').success).toBe(true);
        expect(SlotTimeSchema.safeParse('14:05').success).toBe(true);
      });

      it('accepts valid HH:MM:SS formats', () => {
        expect(SlotTimeSchema.safeParse('09:30:00').success).toBe(true);
        expect(SlotTimeSchema.safeParse('23:59:59').success).toBe(true);
        expect(SlotTimeSchema.safeParse('00:00:01').success).toBe(true);
      });

      it('rejects invalid slot time formats', () => {
        expect(SlotTimeSchema.safeParse('24:00').success).toBe(false);
        expect(SlotTimeSchema.safeParse('25:00').success).toBe(false);
        expect(SlotTimeSchema.safeParse('12:60').success).toBe(false);
        expect(SlotTimeSchema.safeParse('9:30').success).toBe(false);
        expect(SlotTimeSchema.safeParse('12:34:567').success).toBe(false);
        expect(SlotTimeSchema.safeParse('invalid').success).toBe(false);
        expect(SlotTimeSchema.safeParse('').success).toBe(false);
      });
    });

    describe('TimezoneSchema', () => {
      it('defaults to UTC when undefined', () => {
        const res = TimezoneSchema.safeParse(undefined);
        expect(res.success).toBe(true);
        if (res.success) {
          expect(res.data).toBe('UTC');
        }
      });

      it('accepts valid timezone strings', () => {
        expect(TimezoneSchema.safeParse('America/New_York').success).toBe(true);
        expect(TimezoneSchema.safeParse('Asia/Karachi').success).toBe(true);
      });

      it('rejects empty or overly long timezone strings', () => {
        expect(TimezoneSchema.safeParse('').success).toBe(false);
        expect(TimezoneSchema.safeParse('A'.repeat(51)).success).toBe(false);
      });
    });

    describe('CreateQueueSlotRequestSchema', () => {
      it('validates a valid create queue slot request', () => {
        const validPayload = {
          pageId: '11111111-1111-4111-a111-111111111111',
          slotTime: '10:00',
          timezone: 'America/New_York',
        };
        const res = CreateQueueSlotRequestSchema.safeParse(validPayload);
        expect(res.success).toBe(true);
      });

      it('rejects invalid pageId UUID', () => {
        const payload = {
          pageId: 'invalid-uuid',
          slotTime: '10:00',
        };
        const res = CreateQueueSlotRequestSchema.safeParse(payload);
        expect(res.success).toBe(false);
      });
    });

    describe('UpdateQueueSlotRequestSchema', () => {
      it('validates partial slot updates', () => {
        const res = UpdateQueueSlotRequestSchema.safeParse({
          isActive: false,
          slotTime: '18:30:00',
        });
        expect(res.success).toBe(true);
      });
    });

    describe('UpdateQueueScheduleTimezoneRequestSchema', () => {
      it('validates schedule timezone updates with valid timezone', () => {
        const res = UpdateQueueScheduleTimezoneRequestSchema.safeParse({
          timezone: 'Asia/Karachi',
        });
        expect(res.success).toBe(true);
      });

      it('rejects empty timezone', () => {
        const res = UpdateQueueScheduleTimezoneRequestSchema.safeParse({
          timezone: '',
        });
        expect(res.success).toBe(false);
      });
    });

    describe('UpdateQueueScheduleTimezoneResponseSchema', () => {
      it('validates successful response without a realigned count', () => {
        const res = UpdateQueueScheduleTimezoneResponseSchema.safeParse({
          success: true,
          timezone: 'America/New_York',
          updatedCount: 3,
        });
        expect(res.success).toBe(true);
      });

      it('drops the removed realignedQueueCount field instead of validating it', () => {
        // Publisher-driven scheduling removed realignment: a timezone
        // change rewrites nothing, so the field is no longer part of
        // the response contract and must not survive parsing.
        const res = UpdateQueueScheduleTimezoneResponseSchema.safeParse({
          success: true,
          timezone: 'America/New_York',
          updatedCount: 3,
          realignedQueueCount: 5,
        });
        expect(res.success).toBe(true);
        if (res.success) {
          expect('realignedQueueCount' in res.data).toBe(false);
        }
      });

      it('rejects negative updatedCount', () => {
        const res = UpdateQueueScheduleTimezoneResponseSchema.safeParse({
          success: true,
          timezone: 'America/New_York',
          updatedCount: -1,
        });
        expect(res.success).toBe(false);
      });
    });

    describe('PageQueueSlotSchema', () => {
      it('validates complete PageQueueSlot domain model', () => {
        const slot = {
          id: '22222222-2222-4222-a222-222222222222',
          userId: '33333333-3333-4333-a333-333333333333',
          pageId: '11111111-1111-4111-a111-111111111111',
          slotTime: '14:00',
          timezone: 'UTC',
          isActive: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const res = PageQueueSlotSchema.safeParse(slot);
        expect(res.success).toBe(true);
      });
    });

    describe('ListQueueSlotsResponseSchema', () => {
      it('validates list response structure', () => {
        const res = ListQueueSlotsResponseSchema.safeParse({
          slots: [
            {
              id: '22222222-2222-4222-a222-222222222222',
              userId: '33333333-3333-4333-a333-333333333333',
              pageId: '11111111-1111-4111-a111-111111111111',
              slotTime: '14:00',
              timezone: 'UTC',
              isActive: true,
              createdAt: '2026-10-07T12:00:00.000Z',
              updatedAt: '2026-10-07T12:00:00.000Z',
            },
          ],
          total: 1,
        });
        expect(res.success).toBe(true);
      });
    });
  });

  describe('Queue Item & Enqueueing Contracts (T116)', () => {
    describe('QueueItemStatusSchema', () => {
      it('accepts all valid statuses', () => {
        const statuses = ['queued', 'publishing', 'published', 'failed', 'skipped', 'cancelled'];
        for (const status of statuses) {
          expect(QueueItemStatusSchema.safeParse(status).success).toBe(true);
        }
      });

      it('rejects invalid statuses', () => {
        expect(QueueItemStatusSchema.safeParse('pending').success).toBe(false);
        expect(QueueItemStatusSchema.safeParse('processing').success).toBe(false);
        expect(QueueItemStatusSchema.safeParse('unknown').success).toBe(false);
      });
    });

    describe('EnqueueMediaRequestSchema', () => {
      it('accepts valid enqueue request and defaults caption to empty string', () => {
        const res = EnqueueMediaRequestSchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: '44444444-4444-4444-a444-444444444444',
        });
        expect(res.success).toBe(true);
        if (res.success) {
          expect(res.data.caption).toBe('');
          expect(res.data.firstComment).toBeUndefined();
        }
      });

      it('accepts caption up to 5000 characters and first comment up to 2000 characters', () => {
        const res = EnqueueMediaRequestSchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: '44444444-4444-4444-a444-444444444444',
          caption: 'A'.repeat(5000),
          firstComment: 'B'.repeat(2000),
        });
        expect(res.success).toBe(true);
      });

      it('rejects caption exceeding 5000 characters', () => {
        const res = EnqueueMediaRequestSchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: '44444444-4444-4444-a444-444444444444',
          caption: 'A'.repeat(5001),
        });
        expect(res.success).toBe(false);
      });

      it('rejects firstComment exceeding 2000 characters', () => {
        const res = EnqueueMediaRequestSchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: '44444444-4444-4444-a444-444444444444',
          caption: 'Valid caption',
          firstComment: 'B'.repeat(2001),
        });
        expect(res.success).toBe(false);
      });
    });

    describe('UpdateQueueItemRequestSchema', () => {
      it('allows updating status to queued, skipped, or cancelled', () => {
        expect(UpdateQueueItemRequestSchema.safeParse({ status: 'queued' }).success).toBe(true);
        expect(UpdateQueueItemRequestSchema.safeParse({ status: 'skipped' }).success).toBe(true);
        expect(UpdateQueueItemRequestSchema.safeParse({ status: 'cancelled' }).success).toBe(true);
      });

      it('rejects updating status to published or failed via update schema', () => {
        expect(UpdateQueueItemRequestSchema.safeParse({ status: 'published' }).success).toBe(false);
        expect(UpdateQueueItemRequestSchema.safeParse({ status: 'failed' }).success).toBe(false);
      });

      it('enforces character limits on updates', () => {
        // R13: the edit cap matches creation (63,206), not the old
        // 5,000 — a long created post must stay editable.
        expect(UpdateQueueItemRequestSchema.safeParse({ caption: 'C'.repeat(63206) }).success).toBe(true);
        expect(UpdateQueueItemRequestSchema.safeParse({ caption: 'C'.repeat(63207) }).success).toBe(false);
        expect(UpdateQueueItemRequestSchema.safeParse({ firstComment: 'D'.repeat(2001) }).success).toBe(false);
      });

      it('holds reel edits to 2,200 characters (R13)', () => {
        expect(
          UpdateQueueItemRequestSchema.safeParse({ postFormat: 'reel', caption: 'R'.repeat(2200) }).success
        ).toBe(true);
        expect(
          UpdateQueueItemRequestSchema.safeParse({ postFormat: 'reel', caption: 'R'.repeat(2201) }).success
        ).toBe(false);
        // Non-reel formats keep the full creation cap.
        expect(
          UpdateQueueItemRequestSchema.safeParse({ postFormat: 'image', caption: 'C'.repeat(63206) }).success
        ).toBe(true);
      });
    });

    describe('QueueItemSchema', () => {
      it('validates full QueueItem domain model with nullable fields and media details', () => {
        const queueItem = {
          id: '55555555-5555-4555-a555-555555555555',
          userId: '33333333-3333-4333-a333-333333333333',
          pageId: '11111111-1111-4111-a111-111111111111',
          slotId: null,
          mediaId: '44444444-4444-4444-a444-444444444444',
          scheduledTime: '2026-10-07T15:00:00.000Z',
          caption: 'Check out our new reel!',
          firstComment: 'Link in bio: https://example.com',
          status: 'queued',
          retryCount: 0,
          maxRetries: 3,
          fbPostId: null,
          fbCommentId: null,
          publishedAt: null,
          createdAt: '2026-10-07T12:00:00.000Z',
          updatedAt: '2026-10-07T12:00:00.000Z',
          media: {
            name: 'epic_reel.mp4',
            mediaType: 'video',
            thumbnailUrl: 'https://cdn.example.com/thumb.webp',
            url: 'https://cdn.example.com/epic_reel.mp4',
            aspectRatio: '9:16',
            durationSeconds: 45.2,
          },
        };
        const res = QueueItemSchema.safeParse(queueItem);
        expect(res.success).toBe(true);
      });
    });

    describe('ListQueueItemsQuerySchema & ListQueueItemsResponseSchema', () => {
      it('coerces and defaults query pagination parameters', () => {
        const query = ListQueueItemsQuerySchema.safeParse({
          limit: '25',
          offset: '10',
          status: 'queued',
        });
        expect(query.success).toBe(true);
        if (query.success) {
          expect(query.data.limit).toBe(25);
          expect(query.data.offset).toBe(10);
          expect(query.data.status).toBe('queued');
        }
      });

      it('validates ListQueueItemsResponseSchema', () => {
        const res = ListQueueItemsResponseSchema.safeParse({
          items: [],
          total: 0,
          limit: 50,
          offset: 0,
        });
        expect(res.success).toBe(true);
      });
    });
  });

  describe('Edge Dispatcher & Facebook Graph Contracts (T117)', () => {
    describe('ClaimedQueueItemSchema', () => {
      it('validates claimed queue item with joined media and page credentials', () => {
        const claimed = {
          id: '55555555-5555-4555-a555-555555555555',
          userId: '33333333-3333-4333-a333-333333333333',
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: '44444444-4444-4444-a444-444444444444',
          caption: 'Ready for prime time',
          firstComment: null,
          retryCount: 0,
          maxRetries: 3,
          mediaType: 'video',
          mediaUrl: 'https://r2.fbuploadpro.com/tenant/video.mp4',
          storageKey: 'tenant/video.mp4',
          fbPageId: '1029384756',
          encryptedPageToken: 'v1.iv.ciphertext.tag',
          pageName: 'My Awesome Page',
        };
        const res = ClaimedQueueItemSchema.safeParse(claimed);
        expect(res.success).toBe(true);
      });

      it('rejects claimed item if mediaUrl is not a valid URL', () => {
        const claimed = {
          id: '55555555-5555-4555-a555-555555555555',
          userId: '33333333-3333-4333-a333-333333333333',
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: '44444444-4444-4444-a444-444444444444',
          caption: 'Test',
          firstComment: null,
          retryCount: 0,
          maxRetries: 3,
          mediaType: 'video',
          mediaUrl: 'not-a-url',
          storageKey: 'tenant/video.mp4',
          fbPageId: '1029384756',
          encryptedPageToken: 'token',
          pageName: 'My Page',
        };
        const res = ClaimedQueueItemSchema.safeParse(claimed);
        expect(res.success).toBe(false);
      });
    });

    describe('PublishLogSchema', () => {
      it('validates success publish log record', () => {
        const log = {
          id: '66666666-6666-4666-a666-666666666666',
          userId: '33333333-3333-4333-a333-333333333333',
          queueItemId: '55555555-5555-4555-a555-555555555555',
          pageId: '11111111-1111-4111-a111-111111111111',
          status: 'success',
          attemptNumber: 1,
          fbResponseCode: 200,
          errorMessage: null,
          errorDetails: null,
          createdAt: new Date().toISOString(),
        };
        const res = PublishLogSchema.safeParse(log);
        expect(res.success).toBe(true);
      });

      it('validates failure publish log record with error details', () => {
        const log = {
          id: '66666666-6666-4666-a666-666666666666',
          userId: '33333333-3333-4333-a333-333333333333',
          queueItemId: '55555555-5555-4555-a555-555555555555',
          pageId: '11111111-1111-4111-a111-111111111111',
          status: 'failure',
          attemptNumber: 3,
          fbResponseCode: 400,
          errorMessage: 'OAuthException: Session expired',
          errorDetails: { code: 190, subcode: 463 },
          createdAt: new Date().toISOString(),
        };
        const res = PublishLogSchema.safeParse(log);
        expect(res.success).toBe(true);
      });
    });

    describe('ListPublishLogsQuerySchema & ListPublishLogsResponseSchema', () => {
      it('validates and coerces list publish logs query parameters', () => {
        const res = ListPublishLogsQuerySchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          status: 'success',
          limit: '20',
          offset: '5',
        });
        expect(res.success).toBe(true);
        if (res.success) {
          expect(res.data.limit).toBe(20);
          expect(res.data.offset).toBe(5);
          expect(res.data.status).toBe('success');
        }
      });

      it('validates ListPublishLogsResponseSchema', () => {
        const res = ListPublishLogsResponseSchema.safeParse({
          logs: [],
          total: 0,
        });
        expect(res.success).toBe(true);
      });
    });
  });

  describe('Multi-Format 200k/Day Publishing Contracts (Spec 042)', () => {
    describe('PostFormatSchema', () => {
      it('accepts all 5 valid post formats', () => {
        const formats = ['text', 'image', 'reel', 'video', 'story'];
        for (const fmt of formats) {
          expect(PostFormatSchema.safeParse(fmt).success).toBe(true);
        }
      });

      it('rejects invalid post formats', () => {
        expect(PostFormatSchema.safeParse('carousel').success).toBe(false);
        expect(PostFormatSchema.safeParse('audio').success).toBe(false);
        expect(PostFormatSchema.safeParse('').success).toBe(false);
      });
    });

    describe('validatePostFormatEligibility', () => {
      it('validates text posts (requires caption, allows firstComment, rejects media)', () => {
        const validText = validatePostFormatEligibility({
          postFormat: 'text',
          caption: 'Great news today!',
          firstComment: 'Read more here',
          media: null,
        });
        expect(validText.valid).toBe(true);

        const textWithLink = validatePostFormatEligibility({
          postFormat: 'text',
          caption: '',
          linkUrl: 'https://example.com/article',
          media: null,
        });
        expect(textWithLink.valid).toBe(true);

        const invalidEmptyText = validatePostFormatEligibility({
          postFormat: 'text',
          caption: '   ',
          media: null,
        });
        expect(invalidEmptyText.valid).toBe(false);
        expect(invalidEmptyText.error).toContain('non-empty caption or link URL');

        const textWithMedia = validatePostFormatEligibility({
          postFormat: 'text',
          caption: 'Caption',
          media: { mediaType: 'image' },
        });
        expect(textWithMedia.valid).toBe(false);
        expect(textWithMedia.error).toContain('Text posts cannot have attached media');
      });

      it('validates image posts (requires image media, allows firstComment, rejects video)', () => {
        const validImage = validatePostFormatEligibility({
          postFormat: 'image',
          caption: 'Photo of the day',
          firstComment: 'Check out our page',
          media: { mediaType: 'image' },
        });
        expect(validImage.valid).toBe(true);

        const imageWithVideo = validatePostFormatEligibility({
          postFormat: 'image',
          caption: 'Invalid',
          media: { mediaType: 'video' },
        });
        expect(imageWithVideo.valid).toBe(false);
        expect(imageWithVideo.error).toContain('Image posts require an image media asset');

        const imageNoMedia = validatePostFormatEligibility({
          postFormat: 'image',
          caption: 'Missing media',
          media: null,
        });
        expect(imageNoMedia.valid).toBe(false);
      });

      it('validates reel posts (requires video media <= 90s, warns on non-9:16 aspect ratio)', () => {
        const validReel = validatePostFormatEligibility({
          postFormat: 'reel',
          caption: 'Viral reel',
          media: { mediaType: 'video', durationSeconds: 60, aspectRatio: '9:16' },
        });
        expect(validReel.valid).toBe(true);
        expect(validReel.warnings).toBeUndefined();

        const reelAspectWarning = validatePostFormatEligibility({
          postFormat: 'reel',
          caption: 'Horizontal reel',
          media: { mediaType: 'video', durationSeconds: 45, aspectRatio: '16:9' },
        });
        expect(reelAspectWarning.valid).toBe(true);
        expect(reelAspectWarning.warnings).toBeDefined();
        expect(reelAspectWarning.warnings?.[0]).toContain('9:16 vertical aspect ratio');

        const reelTooLong = validatePostFormatEligibility({
          postFormat: 'reel',
          caption: 'Too long',
          media: { mediaType: 'video', durationSeconds: 95 },
        });
        expect(reelTooLong.valid).toBe(false);
        expect(reelTooLong.error).toContain('Reels cannot exceed 90 seconds');
      });

      it('validates video posts (accepts video of any duration and aspect ratio)', () => {
        const validVideo = validatePostFormatEligibility({
          postFormat: 'video',
          caption: 'Full documentary',
          firstComment: 'Subscribe for part 2',
          media: { mediaType: 'video', durationSeconds: 1200, aspectRatio: '16:9' },
        });
        expect(validVideo.valid).toBe(true);

        const videoWithImage = validatePostFormatEligibility({
          postFormat: 'video',
          caption: 'Wrong media',
          media: { mediaType: 'image' },
        });
        expect(videoWithImage.valid).toBe(false);
        expect(videoWithImage.error).toContain('Video posts require a video media asset');
      });

      it('validates story posts (accepts image <=10MB and video <=60s, strictly rejects firstComment)', () => {
        const validPhotoStory = validatePostFormatEligibility({
          postFormat: 'story',
          caption: '',
          firstComment: null,
          media: { mediaType: 'image', fileSize: 5 * 1024 * 1024 },
        });
        expect(validPhotoStory.valid).toBe(true);

        const photoStoryTooLarge = validatePostFormatEligibility({
          postFormat: 'story',
          caption: '',
          media: { mediaType: 'image', fileSize: 12 * 1024 * 1024 },
        });
        expect(photoStoryTooLarge.valid).toBe(false);
        expect(photoStoryTooLarge.error).toContain('Photo Stories cannot exceed 10 MB');

        const validVideoStory = validatePostFormatEligibility({
          postFormat: 'story',
          caption: '',
          media: { mediaType: 'video', durationSeconds: 45 },
        });
        expect(validVideoStory.valid).toBe(true);

        const videoStoryTooLong = validatePostFormatEligibility({
          postFormat: 'story',
          caption: '',
          media: { mediaType: 'video', durationSeconds: 75 },
        });
        expect(videoStoryTooLong.valid).toBe(false);
        expect(videoStoryTooLong.error).toContain('Video Stories cannot exceed 60 seconds');

        const storyWithComment = validatePostFormatEligibility({
          postFormat: 'story',
          caption: '',
          firstComment: 'Check this link',
          media: { mediaType: 'image', fileSize: 1024 * 1024 },
        });
        expect(storyWithComment.valid).toBe(false);
        expect(storyWithComment.error).toContain('Facebook Stories do not support comments');
      });
    });

    describe('getEligiblePostFormatsForMedia', () => {
      it('returns eligible formats for images (image and story if <= 10MB)', () => {
        expect(getEligiblePostFormatsForMedia({ mediaType: 'image', fileSize: 2 * 1024 * 1024 })).toEqual([
          'image',
          'story',
        ]);
        expect(getEligiblePostFormatsForMedia({ mediaType: 'image', fileSize: 15 * 1024 * 1024 })).toEqual([
          'image',
        ]);
      });

      it('returns eligible formats for short vertical videos (video, reel, story)', () => {
        const formats = getEligiblePostFormatsForMedia({
          mediaType: 'video',
          durationSeconds: 30,
          aspectRatio: '9:16',
        });
        expect(formats).toContain('video');
        expect(formats).toContain('reel');
        expect(formats).toContain('story');
      });

      it('returns eligible formats for long videos (> 90s only gets video)', () => {
        const formats = getEligiblePostFormatsForMedia({
          mediaType: 'video',
          durationSeconds: 150,
        });
        expect(formats).toEqual(['video']);
      });

      it('returns video and reel for videos between 60s and 90s', () => {
        const formats = getEligiblePostFormatsForMedia({
          mediaType: 'video',
          durationSeconds: 80,
        });
        expect(formats).toEqual(['video', 'reel']);
      });
    });

    describe('EnqueueMediaRequestSchema format refinements', () => {
      it('allows text post with null mediaId and non-empty caption', () => {
        const valid = EnqueueMediaRequestSchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: null,
          postFormat: 'text',
          caption: 'Hello world text post',
          linkUrl: 'https://example.com',
          firstComment: 'First comment allowed',
        });
        expect(valid.success).toBe(true);
      });

      it('rejects text post with empty caption', () => {
        const invalid = EnqueueMediaRequestSchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: null,
          postFormat: 'text',
          caption: '',
        });
        expect(invalid.success).toBe(false);
      });

      it('rejects non-text post with null mediaId', () => {
        const invalid = EnqueueMediaRequestSchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: null,
          postFormat: 'reel',
          caption: 'Caption',
        });
        expect(invalid.success).toBe(false);
      });

      it('rejects story post with non-empty firstComment', () => {
        const invalid = EnqueueMediaRequestSchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: '22222222-2222-4222-a222-222222222222',
          postFormat: 'story',
          caption: 'Caption',
          firstComment: 'No comments on stories',
        });
        expect(invalid.success).toBe(false);
      });

      it('allows story post with empty string firstComment and normalizes to null', () => {
        const valid = EnqueueMediaRequestSchema.safeParse({
          pageId: '11111111-1111-4111-a111-111111111111',
          mediaId: '22222222-2222-4222-a222-222222222222',
          postFormat: 'story',
          caption: 'Story caption',
          firstComment: '',
        });
        expect(valid.success).toBe(true);
        if (valid.success) {
          expect(valid.data.firstComment).toBeNull();
        }
      });
    });

    describe('PageQueueSlotSchema allowedFormats', () => {
      it('validates allowedFormats array on recurring slot', () => {
        const slot = {
          id: '22222222-2222-4222-a222-222222222222',
          userId: '33333333-3333-4333-a333-333333333333',
          pageId: '11111111-1111-4111-a111-111111111111',
          slotTime: '15:00',
          timezone: 'UTC',
          isActive: true,
          allowedFormats: ['reel', 'story'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        const res = PageQueueSlotSchema.safeParse(slot);
        expect(res.success).toBe(true);
        if (res.success) {
          expect(res.data.allowedFormats).toEqual(['reel', 'story']);
        }
      });
    });
  });
});

