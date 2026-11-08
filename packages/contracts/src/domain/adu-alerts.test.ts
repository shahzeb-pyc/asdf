/**
 * ADU status alerts (B5 copy pass): the creator-suspended copy is the
 * decided all-time-50 wording with no source change, in every
 * platform's alert function. The Instagram alert must never name
 * Facebook, Business Manager, or Facebook Accounts — it is shown in
 * the Instagram section.
 */
import { describe, expect, it } from 'vitest';
import {
  aduStatusAlert,
  instagramAduStatusAlert,
  threadsAduStatusAlert,
} from './adu.js';

const DECIDED_CREATOR_COPY =
  'This source is unavailable after more than 50 failed downloads. Turn automation on to check whether the creator is available again.';

describe('ADU creator-suspended alert copy', () => {
  it.each([
    ['Facebook', aduStatusAlert],
    ['Instagram', instagramAduStatusAlert],
    ['Threads', threadsAduStatusAlert],
  ])('%s alert uses the decided all-time-50 copy, never a source change', (_name, alertFn) => {
    expect(alertFn('creator_suspended', 'synced')).toBe(DECIDED_CREATOR_COPY);
  });
});

describe('instagramAduStatusAlert', () => {
  it('names Instagram Accounts for an invalid connection, never Facebook', () => {
    const alert = instagramAduStatusAlert('invalid_token', 'synced');
    expect(alert).toContain('Instagram Accounts');
    expect(alert).not.toMatch(/Facebook/i);
  });

  it('never mentions Facebook or Business Manager for any status', () => {
    const statuses = [
      'paused',
      'completed',
      'fb_verification_required',
      'invalid_token',
      'fb_rate_limited',
      'page_not_accessible',
      'invalid_username',
      'creator_suspended',
      '2fa_required_on_BM',
      'check_developer_app',
      'account_suspended',
      'missing_page_access',
      'missing_permission',
    ] as const;
    for (const status of statuses) {
      const alert = instagramAduStatusAlert(status, 'synced');
      expect(alert, status).not.toMatch(/Facebook|Business Manager/i);
    }
  });

  it('covers the two new statuses', () => {
    expect(instagramAduStatusAlert('missing_page_access', 'synced')).toMatch(
      /restore access/
    );
    expect(instagramAduStatusAlert('missing_permission', 'synced')).toMatch(
      /grant the permission/
    );
  });

  it('returns null when active', () => {
    expect(instagramAduStatusAlert('active', 'synced')).toBeNull();
  });
});
