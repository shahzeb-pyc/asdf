import { describe, it, expect } from 'vitest';
import { isScheduleListMember } from './instagram-schedule';
import { isThreadsScheduleListMember } from './threads-schedule';

/**
 * Spec 174 Phase 4 — list membership is the section column alone.
 * A removed stub (section 'schedule', status 'disconnected') is NOT
 * a member: removal disconnects + strips it, and it must vanish from
 * the list. A paused row (disconnected + paused marker) IS a member.
 * The old membership flags (Instagram `scheduled`, Threads
 * `threads_schedule_added_at`) are no longer read: a disconnected
 * row without the paused marker is not a member whether or not the
 * flag is set. Connection-died rows are status 'error' (expiry
 * propagation), not 'disconnected', so they stay members through the
 * status branch. Live data at build time confirms zero
 * disconnected+flag-set schedule rows exist, so the flag-read
 * removal changes no live list membership.
 */
describe('isScheduleListMember (Instagram)', () => {
  it('an active schedule copy is a member', () => {
    expect(
      isScheduleListMember({
        section: 'schedule',
        status: 'active',
        metadata: { scheduled: true },
      })
    ).toBe(true);
  });

  it('a disconnected copy with the flag set but no paused marker is NOT a member (flag ignored)', () => {
    expect(
      isScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: { scheduled: true },
      })
    ).toBe(false);
  });

  it('a paused copy is a member (disconnected + paused marker)', () => {
    expect(
      isScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: { schedule_paused: 'paused' },
      })
    ).toBe(true);
  });

  it('a paused copy is a member even with the flag set (paused wins)', () => {
    expect(
      isScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: { scheduled: true, schedule_paused: 'paused' },
      })
    ).toBe(true);
  });

  it('a removed stub is not a member (disconnected, flag cleared)', () => {
    expect(
      isScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: {},
      })
    ).toBe(false);
  });

  it('a removed stub with null metadata is not a member', () => {
    expect(
      isScheduleListMember({ section: 'schedule', status: 'disconnected', metadata: null })
    ).toBe(false);
  });

  it('a row in another section is not a member', () => {
    expect(
      isScheduleListMember({
        section: 'adu',
        status: 'active',
        metadata: { scheduled: true },
      })
    ).toBe(false);
  });

  it('an unimported row (null section) is not a member', () => {
    expect(
      isScheduleListMember({ section: null, status: 'active', metadata: null })
    ).toBe(false);
  });
});

describe('isThreadsScheduleListMember', () => {
  it('an active schedule copy is a member', () => {
    expect(
      isThreadsScheduleListMember({
        section: 'schedule',
        status: 'active',
        metadata: { threads_schedule_added_at: '2026-11-12T00:00:00.000Z' },
      })
    ).toBe(true);
  });

  it('a disconnected copy with the flag set but no paused marker is NOT a member (flag ignored)', () => {
    expect(
      isThreadsScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: { threads_schedule_added_at: '2026-11-12T00:00:00.000Z' },
      })
    ).toBe(false);
  });

  it('a paused copy is a member (disconnected + paused marker)', () => {
    expect(
      isThreadsScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: {
          threads_schedule_added_at: '2026-11-12T00:00:00.000Z',
          threads_schedule_status: 'paused',
        },
      })
    ).toBe(true);
  });

  it('a paused copy is a member even without the flag (paused wins)', () => {
    expect(
      isThreadsScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: { threads_schedule_status: 'paused' },
      })
    ).toBe(true);
  });

  it('a removed stub is not a member (disconnected, flag cleared)', () => {
    expect(
      isThreadsScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: {},
      })
    ).toBe(false);
  });

  it('a row in another section is not a member', () => {
    expect(
      isThreadsScheduleListMember({
        section: 'adu',
        status: 'active',
        metadata: { threads_schedule_added_at: '2026-11-12T00:00:00.000Z' },
      })
    ).toBe(false);
  });

  it('an unimported row (null section) is not a member', () => {
    expect(
      isThreadsScheduleListMember({ section: null, status: 'active', metadata: null })
    ).toBe(false);
  });
});
