import { describe, expect, it } from 'vitest';

import {
  canAddInstagramSchedule,
  IG_SCHEDULE_FORMATS,
  isInstagramScheduleFormat,
  isInstagramScheduleSlotKind,
  validateInstagramScheduleSlots,
} from '../src/publishing/instagram-schedule.js';

describe('instagram schedule contracts', () => {
  it('offers only photo, reel and carousel — never text or story', () => {
    expect([...IG_SCHEDULE_FORMATS]).toEqual(['image', 'reel', 'carousel']);
    expect(isInstagramScheduleFormat('text')).toBe(false);
    expect(isInstagramScheduleFormat('story')).toBe(false);
    expect(isInstagramScheduleFormat('reel')).toBe(true);
  });

  it('accepts video only as a slot-matching kind, not as a composer format', () => {
    expect(isInstagramScheduleSlotKind('video')).toBe(true);
    expect(isInstagramScheduleFormat('video')).toBe(false);
  });

  it('allows adding while the cap is unset (unlimited)', () => {
    expect(canAddInstagramSchedule(999)).toEqual({ allowed: true });
  });

  it('rejects duplicate posting times and bad formats', () => {
    expect(
      validateInstagramScheduleSlots([
        { time: '09:00', formats: ['image'] },
        { time: '09:00', formats: ['reel'] },
      ])
    ).toMatch(/more than once/);
    expect(
      validateInstagramScheduleSlots([{ time: '25:00' }])
    ).toMatch(/HH:MM/);
    expect(
      validateInstagramScheduleSlots([{ time: '09:00', formats: ['text'] }])
    ).toMatch(/Unsupported posting format/);
    expect(
      validateInstagramScheduleSlots([{ time: '09:00', formats: ['image'] }])
    ).toBeNull();
  });
});
