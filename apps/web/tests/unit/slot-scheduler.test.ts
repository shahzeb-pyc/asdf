import { describe, expect, it } from 'vitest';
import {
  calculateNextVacantSlot,
  type SlotSchedulerParams,
} from '../../src/lib/slot-scheduler';

describe('calculateNextVacantSlot (T124)', () => {
  describe('empty or inactive slots', () => {
    it('returns null when slots array is empty', () => {
      const result = calculateNextVacantSlot({
        slots: [],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toBeNull();
    });

    it('returns null when all slots are inactive', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-1', slotTime: '12:00:00', timezone: 'UTC', isActive: false },
          { id: 'slot-2', slotTime: '18:00:00', timezone: 'UTC', isActive: false },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toBeNull();
    });

    it('ignores inactive slots and selects the first active slot', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-inactive-early', slotTime: '11:00:00', timezone: 'UTC', isActive: false },
          { id: 'slot-active-later', slotTime: '15:00:00', timezone: 'UTC', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).not.toBeNull();
      expect(result?.slotId).toBe('slot-active-later');
      expect(result?.scheduledTime.toISOString()).toBe('2026-10-07T15:00:00.000Z');
    });
  });

  describe('finding next vacant slot today', () => {
    it('finds the next vacant slot today when time has not passed', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-1', slotTime: '14:00:00', timezone: 'UTC', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-1',
        scheduledTime: new Date('2026-10-07T14:00:00.000Z'),
      });
    });

    it('finds the earliest chronological active slot today among multiple slots', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-evening', slotTime: '19:00', timezone: 'UTC', isActive: true },
          { id: 'slot-afternoon', slotTime: '15:00', timezone: 'UTC', isActive: true },
          { id: 'slot-morning', slotTime: '11:00', timezone: 'UTC', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T12:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-afternoon',
        scheduledTime: new Date('2026-10-07T15:00:00.000Z'),
      });
    });

    it('works with both HH:mm and HH:mm:ss format', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-mmss', slotTime: '14:30:45', timezone: 'UTC', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-mmss',
        scheduledTime: new Date('2026-10-07T14:30:45.000Z'),
      });
    });
  });

  describe('skipping occupied slots', () => {
    it('skips occupied slots and selects the next available slot today', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-1', slotTime: '14:00:00', timezone: 'UTC', isActive: true },
          { id: 'slot-2', slotTime: '18:00:00', timezone: 'UTC', isActive: true },
        ],
        existingScheduledTimes: [
          new Date('2026-10-07T14:00:00.000Z'),
        ],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-2',
        scheduledTime: new Date('2026-10-07T18:00:00.000Z'),
      });
    });

    it('handles multiple booked slots correctly', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-1', slotTime: '09:00:00', timezone: 'UTC', isActive: true },
          { id: 'slot-2', slotTime: '12:00:00', timezone: 'UTC', isActive: true },
          { id: 'slot-3', slotTime: '15:00:00', timezone: 'UTC', isActive: true },
        ],
        existingScheduledTimes: [
          new Date('2026-10-07T09:00:00.000Z'),
          new Date('2026-10-07T12:00:00.000Z'),
        ],
        now: new Date('2026-10-07T08:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-3',
        scheduledTime: new Date('2026-10-07T15:00:00.000Z'),
      });
    });
  });

  describe('rolling over to tomorrow and future days', () => {
    it('rolls over to tomorrow when today slot time has already passed', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-1', slotTime: '09:00:00', timezone: 'UTC', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-1',
        scheduledTime: new Date('2026-10-08T09:00:00.000Z'),
      });
    });

    it('rolls over to tomorrow when today all slots are booked', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-1', slotTime: '14:00:00', timezone: 'UTC', isActive: true },
          { id: 'slot-2', slotTime: '18:00:00', timezone: 'UTC', isActive: true },
        ],
        existingScheduledTimes: [
          new Date('2026-10-07T14:00:00.000Z'),
          new Date('2026-10-07T18:00:00.000Z'),
        ],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-1',
        scheduledTime: new Date('2026-10-08T14:00:00.000Z'),
      });
    });

    it('rolls over multiple days when consecutive days are booked', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-1', slotTime: '12:00:00', timezone: 'UTC', isActive: true },
        ],
        existingScheduledTimes: [
          new Date('2026-10-07T12:00:00.000Z'),
          new Date('2026-10-08T12:00:00.000Z'),
          new Date('2026-10-09T12:00:00.000Z'),
        ],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-1',
        scheduledTime: new Date('2026-10-10T12:00:00.000Z'),
      });
    });
  });

  describe('timezone conversion', () => {
    it('correctly converts America/New_York (EDT UTC-4) slot time to UTC', () => {
      // 09:00 EDT on 2026-10-07 is 13:00 UTC
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-ny', slotTime: '09:00:00', timezone: 'America/New_York', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T11:00:00.000Z'), // 07:00 EDT
      });

      expect(result).toEqual({
        slotId: 'slot-ny',
        scheduledTime: new Date('2026-10-07T13:00:00.000Z'),
      });
    });

    it('correctly converts Europe/London (BST UTC+1 in October) slot time to UTC', () => {
      // 14:00 BST on 2026-10-07 is 13:00 UTC
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-lon', slotTime: '14:00:00', timezone: 'Europe/London', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T11:00:00.000Z'), // 12:00 BST
      });

      expect(result).toEqual({
        slotId: 'slot-lon',
        scheduledTime: new Date('2026-10-07T13:00:00.000Z'),
      });
    });

    it('handles Europe/London winter time (GMT UTC+0 in January)', () => {
      // 14:00 GMT on 2026-01-15 is 14:00 UTC
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-lon-winter', slotTime: '14:00:00', timezone: 'Europe/London', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-01-15T11:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-lon-winter',
        scheduledTime: new Date('2026-01-15T14:00:00.000Z'),
      });
    });

    it('orders multi-timezone slots chronologically in UTC', () => {
      // At now = 2026-10-07T10:00:00.000Z:
      // slot-ny: 09:00 America/New_York (EDT) = 13:00 UTC
      // slot-lon: 12:00 Europe/London (BST) = 11:00 UTC
      // 11:00 UTC comes before 13:00 UTC
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-ny', slotTime: '09:00:00', timezone: 'America/New_York', isActive: true },
          { id: 'slot-lon', slotTime: '12:00:00', timezone: 'Europe/London', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-lon',
        scheduledTime: new Date('2026-10-07T11:00:00.000Z'),
      });
    });

    it('falls back to UTC when an unknown timezone is provided', () => {
      const result = calculateNextVacantSlot({
        slots: [
          { id: 'slot-fallback', slotTime: '15:00:00', timezone: 'Unknown/Invalid_Zone', isActive: true },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
      });

      expect(result).toEqual({
        slotId: 'slot-fallback',
        scheduledTime: new Date('2026-10-07T15:00:00.000Z'),
      });
    });
  });

  describe('default now parameter', () => {
    it('uses current Date when now is omitted', () => {
      // Future slot today or tomorrow
      const futureHour = (new Date().getUTCHours() + 2) % 24;
      const slotTime = `${String(futureHour).padStart(2, '0')}:00:00`;

      const result = calculateNextVacantSlot({
        slots: [{ id: 'slot-curr', slotTime, timezone: 'UTC', isActive: true }],
        existingScheduledTimes: [],
      });

      expect(result).not.toBeNull();
      expect(result?.slotId).toBe('slot-curr');
      expect(result?.scheduledTime.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('format-aware slot scheduling (Spec 045 / Issue 11)', () => {
    it('filters candidate slots matching postFormat against allowedFormats', () => {
      const result = calculateNextVacantSlot({
        slots: [
          {
            id: 'slot-reels-only',
            slotTime: '11:00:00',
            timezone: 'UTC',
            isActive: true,
            allowedFormats: ['reel'],
          },
          {
            id: 'slot-posts-only',
            slotTime: '12:00:00',
            timezone: 'UTC',
            isActive: true,
            allowedFormats: ['post_image', 'post_video'],
          },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
        postFormat: 'post_image',
      });

      expect(result).toEqual({
        slotId: 'slot-posts-only',
        scheduledTime: new Date('2026-10-07T12:00:00.000Z'),
      });
    });

    it('allows any postFormat if slot allowedFormats is null or empty', () => {
      const result = calculateNextVacantSlot({
        slots: [
          {
            id: 'slot-universal',
            slotTime: '11:00:00',
            timezone: 'UTC',
            isActive: true,
            allowedFormats: null,
          },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
        postFormat: 'story_photo',
      });

      expect(result).toEqual({
        slotId: 'slot-universal',
        scheduledTime: new Date('2026-10-07T11:00:00.000Z'),
      });
    });

    it('returns null if no active slots support the postFormat', () => {
      const result = calculateNextVacantSlot({
        slots: [
          {
            id: 'slot-reels-only',
            slotTime: '11:00:00',
            timezone: 'UTC',
            isActive: true,
            allowedFormats: ['reel'],
          },
        ],
        existingScheduledTimes: [],
        now: new Date('2026-10-07T10:00:00.000Z'),
        postFormat: 'post_text',
      });

      expect(result).toBeNull();
    });
  });
});
