/**
 * ADU hub/detail badge (spec 201, owner rule 2026-11-17): the setup
 * (source) status shows ONLY when the source failed to scrape
 * (`sync_status === 'error'`); otherwise the card shows the page
 * (destination) status directly. The bug this pins: an error
 * destination with an active config read as `Active posting`
 * (beekainternational, Nov 9 identity checkpoint — destinations in
 * `error`, configs still `active` after reactivation).
 */
import { describe, expect, it } from 'vitest';
import { aduDisplayStatus } from './adu.js';

describe('aduDisplayStatus (spec 201)', () => {
  it('shows the setup status only on a failed scrape', () => {
    expect(aduDisplayStatus('active', 'error', { status: 'error' })).toBe(
      'Source not found',
    );
    expect(aduDisplayStatus('active', 'error', { status: 'active' })).toBe(
      'Source not found',
    );
  });

  it('shows the page status when the destination is active', () => {
    expect(aduDisplayStatus('active', 'synced', { status: 'active' })).toBe(
      'Active posting',
    );
    expect(aduDisplayStatus('paused', 'synced', { status: 'active' })).toBe(
      'Paused',
    );
    expect(aduDisplayStatus('completed', 'synced', { status: 'active' })).toBe(
      'All reels posted',
    );
  });

  it('keeps the config-carried error label for an active destination', () => {
    expect(
      aduDisplayStatus('invalid_token', 'synced', { status: 'active' }),
    ).toBe('Invalid token');
  });

  it('never says Active posting for an error destination', () => {
    // The bug case: error destination + active config.
    const label = aduDisplayStatus('active', 'synced', { status: 'error' });
    expect(label).toBe('Error');
    expect(label).not.toBe('Active posting');
  });

  it('maps an error destination marker to its specific label', () => {
    expect(
      aduDisplayStatus('active', 'synced', { status: 'error', fbStatus: 'checkpoint' }),
    ).toBe('Verification required');
    expect(
      aduDisplayStatus('active', 'synced', { status: 'error', fbStatus: 'invalid_token' }),
    ).toBe('Invalid token');
    expect(
      aduDisplayStatus('active', 'synced', {
        status: 'error',
        fbStatus: 'page_not_accessible',
      }),
    ).toBe('Page not accessible');
    expect(
      aduDisplayStatus('active', 'synced', {
        status: 'error',
        fbStatus: 'missing_page_access',
      }),
    ).toBe('Missing page access');
    expect(
      aduDisplayStatus('active', 'synced', { status: 'error', fbStatus: '2fa_required_on_BM' }),
    ).toBe('BM 2FA required');
  });

  it('reads generic Error for an error destination with no usable marker', () => {
    // No marker: the ADU tick does not write metadata.fb_status on
    // publish failure, so this is the common case, not an edge.
    expect(aduDisplayStatus('active', 'synced', { status: 'error' })).toBe('Error');
    expect(
      aduDisplayStatus('active', 'synced', { status: 'error', fbStatus: null }),
    ).toBe('Error');
    // A marker that cannot ride an error row asserts no cause.
    expect(
      aduDisplayStatus('active', 'synced', { status: 'error', fbStatus: 'paused' }),
    ).toBe('Error');
    expect(
      aduDisplayStatus('active', 'synced', { status: 'error', fbStatus: 'bogus' }),
    ).toBe('Error');
  });

  it('shows the destination status for rate-limited and disconnected pages', () => {
    expect(aduDisplayStatus('active', 'synced', { status: 'rate_limited' })).toBe(
      'Rate limited',
    );
    expect(aduDisplayStatus('active', 'synced', { status: 'disconnected' })).toBe(
      'Disconnected',
    );
  });

  it('never reads an unknown destination status as healthy', () => {
    expect(aduDisplayStatus('active', 'synced', { status: 'weird' })).toBe('Error');
  });

  it('falls back to the config status with no destination row', () => {
    expect(aduDisplayStatus('active', 'synced')).toBe('Active posting');
    expect(aduDisplayStatus('active', 'synced', null)).toBe('Active posting');
    expect(aduDisplayStatus('paused', 'synced', null)).toBe('Paused');
  });

  it('shows the page status while a scrape is pending or running', () => {
    // Owner rule: only a FAILED scrape shows the setup status.
    // A scrape in flight is not a failure — the page status shows.
    expect(aduDisplayStatus('active', 'processing', { status: 'active' })).toBe(
      'Active posting',
    );
    expect(aduDisplayStatus('active', 'pending', { status: 'error' })).toBe('Error');
    expect(
      aduDisplayStatus('active', 'quota_parked', { status: 'active' }),
    ).toBe('Active posting');
  });
});
