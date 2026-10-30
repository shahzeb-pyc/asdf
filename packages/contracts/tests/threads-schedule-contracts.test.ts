import { describe, expect, it } from 'vitest';
import {
  AddThreadsScheduleRequestSchema,
  CreateThreadsScheduleSlotRequestSchema,
  isThreadsScheduleAdded,
  isThreadsSchedulePaused,
  ListThreadsScheduleQueueResponseSchema,
  threadsScheduleStatusFromRows,
  ThreadsScheduleFormatSchema,
  UpdateThreadsScheduleRequestSchema,
} from '../src/domain/threads-schedule.js';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('ThreadsScheduleFormatSchema', () => {
  it('accepts only the post types Threads supports', () => {
    for (const format of ['text', 'image', 'video', 'carousel']) {
      expect(ThreadsScheduleFormatSchema.safeParse(format).success).toBe(true);
    }
  });

  it('rejects story and reel as separate formats', () => {
    expect(ThreadsScheduleFormatSchema.safeParse('story').success).toBe(false);
    expect(ThreadsScheduleFormatSchema.safeParse('reel').success).toBe(false);
  });
});

describe('AddThreadsScheduleRequestSchema', () => {
  it('accepts a valid add with at least one posting time', () => {
    const parsed = AddThreadsScheduleRequestSchema.safeParse({
      destinationId: UUID,
      timezone: 'Asia/Karachi',
      postingTimes: [{ time: '09:00', formats: ['text', 'image'] }],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an add with no posting times', () => {
    expect(
      AddThreadsScheduleRequestSchema.safeParse({
        destinationId: UUID,
        timezone: 'Asia/Karachi',
        postingTimes: [],
      }).success
    ).toBe(false);
  });

  it('rejects a posting time with no formats', () => {
    expect(
      AddThreadsScheduleRequestSchema.safeParse({
        destinationId: UUID,
        timezone: 'Asia/Karachi',
        postingTimes: [{ time: '09:00', formats: [] }],
      }).success
    ).toBe(false);
  });

  it('rejects a non-IANA timezone', () => {
    expect(
      AddThreadsScheduleRequestSchema.safeParse({
        destinationId: UUID,
        timezone: 'Not/AZone',
        postingTimes: [{ time: '09:00', formats: ['text'] }],
      }).success
    ).toBe(false);
  });
});

describe('CreateThreadsScheduleSlotRequestSchema', () => {
  it('rejects a malformed clock time', () => {
    expect(
      CreateThreadsScheduleSlotRequestSchema.safeParse({
        time: '9:00',
        formats: ['text'],
      }).success
    ).toBe(false);
    expect(
      CreateThreadsScheduleSlotRequestSchema.safeParse({
        time: '25:00',
        formats: ['text'],
      }).success
    ).toBe(false);
  });
});

describe('UpdateThreadsScheduleRequestSchema', () => {
  it('rejects an empty update', () => {
    expect(UpdateThreadsScheduleRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a pause-only update', () => {
    expect(
      UpdateThreadsScheduleRequestSchema.safeParse({ status: 'paused' }).success
    ).toBe(true);
  });
});

describe('schedule membership flags', () => {
  it('is added only when the metadata flag is a non-empty string', () => {
    expect(isThreadsScheduleAdded({ threads_schedule_added_at: '2026-10-31T00:00:00Z' })).toBe(true);
    expect(isThreadsScheduleAdded({})).toBe(false);
    expect(isThreadsScheduleAdded(null)).toBe(false);
    expect(isThreadsScheduleAdded({ threads_schedule_added_at: '' })).toBe(false);
  });

  it('is paused only on the exact paused marker', () => {
    expect(isThreadsSchedulePaused({ threads_schedule_status: 'paused' })).toBe(true);
    expect(isThreadsSchedulePaused({ threads_schedule_status: 'active' })).toBe(false);
    expect(isThreadsSchedulePaused(null)).toBe(false);
  });
});

describe('threadsScheduleStatusFromRows', () => {
  it('pause wins over every other state, so paused destinations are never claimed', () => {
    expect(
      threadsScheduleStatusFromRows({
        destinationStatus: 'active',
        paused: true,
        accountExpired: false,
      })
    ).toBe('paused');
  });

  it('expiry wins over active', () => {
    expect(
      threadsScheduleStatusFromRows({
        destinationStatus: 'active',
        paused: false,
        accountExpired: true,
      })
    ).toBe('expired');
  });

  it('passes active and rate_limited through', () => {
    expect(
      threadsScheduleStatusFromRows({
        destinationStatus: 'active',
        paused: false,
        accountExpired: false,
      })
    ).toBe('active');
    expect(
      threadsScheduleStatusFromRows({
        destinationStatus: 'rate_limited',
        paused: false,
        accountExpired: false,
      })
    ).toBe('rate_limited');
  });
});

describe('ListThreadsScheduleQueueResponseSchema', () => {
  it('rejects a queue item kind Threads cannot create', () => {
    expect(
      ListThreadsScheduleQueueResponseSchema.safeParse({
        items: [
          {
            id: UUID,
            kind: 'story',
            caption: '',
            mediaName: null,
            mediaThumbnailUrl: null,
            scheduledTime: null,
            status: 'queued',
            errorMessage: null,
            externalPostId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        counts: { queued: 1, publishing: 0, published: 0, failed: 0, cancelled: 0 },
      }).success
    ).toBe(false);
  });
});
