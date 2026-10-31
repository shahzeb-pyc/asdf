import { describe, expect, it } from 'vitest';
import { threadsAduStatusAlert } from '../src/domain/adu.js';

describe('threadsAduStatusAlert', () => {
  it('returns null for an active, synced config', () => {
    expect(threadsAduStatusAlert('active', 'synced')).toBeNull();
  });

  it('points an invalid token at Threads Accounts, never Facebook Accounts', () => {
    expect(threadsAduStatusAlert('invalid_token', 'synced')).toBe(
      'The Threads connection is invalid. Reconnect the account in Threads Accounts.',
    );
  });

  it('maps Facebook-only statuses to Threads wording without Facebook copy', () => {
    const alert = threadsAduStatusAlert('fb_verification_required', 'synced');
    expect(alert).toContain('Threads');
    expect(alert).not.toContain('Facebook');
    expect(threadsAduStatusAlert('account_suspended', 'synced')).toContain('Threads');
  });

  it('keeps the shared source-not-found message on a sync error', () => {
    expect(threadsAduStatusAlert('active', 'error')).toBe(
      'The source could not be found. Check the source username in Settings, then try again.',
    );
  });
});
