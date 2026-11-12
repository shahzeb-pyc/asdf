import { describe, it, expect } from 'vitest';
import { isScheduleListMember } from './instagram-schedule';
import { isThreadsScheduleListMember } from './threads-schedule';

/**
 * Spec 174 1B — list membership is the section column, with the
 * scheduled flag as the tiebreaker for disconnected rows.
 *
 * A removed stub (section 'schedule', disconnected, flag cleared)
 * is NOT a member: removal disconnects + strips it, and it must
 * vanish from the list. A connection-died row (disconnected, flag
 * still set) IS a member: it shows as disconnected with reconnect
 * guidance, exactly as before. A paused Threads row (disconnected
 * + paused marker) is a member too.
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

  it('a disconnected copy with the flag still set is a member (connection died)', () => {
    expect(
      isScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: { scheduled: true },
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

  it('a disconnected copy with the flag still set is a member (connection died)', () => {
    expect(
      isThreadsScheduleListMember({
        section: 'schedule',
        status: 'disconnected',
        metadata: { threads_schedule_added_at: '2026-11-12T00:00:00.000Z' },
      })
    ).toBe(true);
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
