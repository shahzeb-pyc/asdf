/**
 * Spec 155: the shared Pages/mirrors display definition. The badge
 * labels, the filter mapping, the detail banner, and the mirror
 * detail mapping are pinned here so the two surfaces cannot drift.
 */
import { describe, expect, it } from 'vitest';
import {
  FB_PAGE_STATUS_FILTER_TO_WIRE,
  FB_PAGE_STATUS_LABELS,
  getFacebookPageStatusAlert,
  isFacebookPageErrorStatus,
  MIRROR_FB_STATUS_LABELS,
  mirrorFbStatusFromPageStatus,
  pageStatusFromMirrorFbStatus,
} from './facebook-page-status.js';

describe('FB_PAGE_STATUS_LABELS — spec 155', () => {
  it('keeps Active (owner default 3) and Identity Checkpoint (default 1)', () => {
    expect(FB_PAGE_STATUS_LABELS.active).toBe('Active');
    expect(FB_PAGE_STATUS_LABELS.page_checkpoint).toBe('Identity Checkpoint');
  });

  it('uses ADU wording for the error statuses', () => {
    expect(FB_PAGE_STATUS_LABELS.invalid_token).toBe('Invalid token');
    expect(FB_PAGE_STATUS_LABELS.fb_rate_limited).toBe('Rate limited');
    expect(FB_PAGE_STATUS_LABELS.page_not_accessible).toBe('Page not accessible');
    expect(FB_PAGE_STATUS_LABELS.missing_page_access).toBe('Missing page access');
    expect(FB_PAGE_STATUS_LABELS.missing_permission).toBe('Missing permission');
    expect(FB_PAGE_STATUS_LABELS.check_developer_app).toBe('Check developer app');
    expect(FB_PAGE_STATUS_LABELS.account_suspended).toBe('Account suspended');
    expect(FB_PAGE_STATUS_LABELS['2fa_required_on_BM']).toBe('BM 2FA required');
  });

  it('every error status is needs-attention; active/paused/disconnected are not', () => {
    for (const status of [
      'invalid_token',
      'page_checkpoint',
      'fb_rate_limited',
      'page_not_accessible',
      'missing_page_access',
      'missing_permission',
      'check_developer_app',
      'account_suspended',
      '2fa_required_on_BM',
    ] as const) {
      expect(isFacebookPageErrorStatus(status)).toBe(true);
    }
    expect(isFacebookPageErrorStatus('active')).toBe(false);
    expect(isFacebookPageErrorStatus('paused')).toBe(false);
    expect(isFacebookPageErrorStatus('disconnected')).toBe(false);
    expect(isFacebookPageErrorStatus('bogus')).toBe(false);
  });
});

describe('FB_PAGE_STATUS_FILTER_TO_WIRE — spec 155', () => {
  it('maps every filter label to its wire status', () => {
    expect(FB_PAGE_STATUS_FILTER_TO_WIRE['All Statuses']).toBeNull();
    expect(FB_PAGE_STATUS_FILTER_TO_WIRE['Verification Req.']).toBe('page_checkpoint');
    expect(FB_PAGE_STATUS_FILTER_TO_WIRE['Rate Limited']).toBe('fb_rate_limited');
    expect(FB_PAGE_STATUS_FILTER_TO_WIRE['Invalid Token']).toBe('invalid_token');
    expect(FB_PAGE_STATUS_FILTER_TO_WIRE['Missing Page Access']).toBe('missing_page_access');
    expect(FB_PAGE_STATUS_FILTER_TO_WIRE['Missing Permission']).toBe('missing_permission');
  });
});

describe('getFacebookPageStatusAlert — spec 155', () => {
  it('active, paused and disconnected show no banner', () => {
    expect(getFacebookPageStatusAlert('active')).toBeNull();
    expect(getFacebookPageStatusAlert('paused')).toBeNull();
    expect(getFacebookPageStatusAlert('disconnected')).toBeNull();
  });

  it('invalid token keeps the reconnect action', () => {
    const alert = getFacebookPageStatusAlert('invalid_token');
    expect(alert?.title).toBe('Access Token Expired');
    expect(alert?.variant).toBe('critical');
    expect(alert?.action).toBe('reconnect');
    expect(alert?.description).toContain('Reconnect your Facebook account');
  });

  it('checkpoint keeps the Mark Verified action and never says reconnect', () => {
    const alert = getFacebookPageStatusAlert('page_checkpoint');
    expect(alert?.title).toBe('Facebook Verification Required');
    expect(alert?.action).toBe('mark_verified');
    expect(alert?.description).toContain('do not reconnect');
  });

  it('rate limited has no action and names the 3-day auto-resume', () => {
    const alert = getFacebookPageStatusAlert('fb_rate_limited');
    expect(alert?.title).toBe('Facebook Rate Limited');
    expect(alert?.action).toBeNull();
    expect(alert?.description).toContain('about 3 days');
  });

  it('no banner says "toggle" anywhere — Pages/mirrors have no toggle', () => {
    for (const status of [
      'invalid_token',
      'page_checkpoint',
      'fb_rate_limited',
      'page_not_accessible',
      'missing_page_access',
      'missing_permission',
      'check_developer_app',
      'account_suspended',
      '2fa_required_on_BM',
    ] as const) {
      const alert = getFacebookPageStatusAlert(status);
      expect(alert).not.toBeNull();
      expect(alert?.description).not.toContain('toggle');
      expect(alert?.variant).toBe('critical');
    }
  });

  it('every error status has a banner', () => {
    for (const status of [
      'invalid_token',
      'page_checkpoint',
      'fb_rate_limited',
      'page_not_accessible',
      'missing_page_access',
      'missing_permission',
      'check_developer_app',
      'account_suspended',
      '2fa_required_on_BM',
    ] as const) {
      expect(getFacebookPageStatusAlert(status)).not.toBeNull();
    }
  });
});

describe('mirror fb_status mapping — spec 155', () => {
  it('page_checkpoint maps to checkpoint; the rest pass through; active maps to null', () => {
    expect(mirrorFbStatusFromPageStatus('page_checkpoint')).toBe('checkpoint');
    expect(mirrorFbStatusFromPageStatus('invalid_token')).toBe('invalid_token');
    expect(mirrorFbStatusFromPageStatus('fb_rate_limited')).toBe('fb_rate_limited');
    expect(mirrorFbStatusFromPageStatus('missing_permission')).toBe('missing_permission');
    expect(mirrorFbStatusFromPageStatus('active')).toBeNull();
    expect(mirrorFbStatusFromPageStatus('paused')).toBeNull();
    expect(mirrorFbStatusFromPageStatus(null)).toBeNull();
  });

  it('mirror fb_status maps back to the wire status', () => {
    expect(pageStatusFromMirrorFbStatus('checkpoint')).toBe('page_checkpoint');
    expect(pageStatusFromMirrorFbStatus('invalid_token')).toBe('invalid_token');
    expect(pageStatusFromMirrorFbStatus(null)).toBeNull();
    expect(pageStatusFromMirrorFbStatus('bogus')).toBeNull();
  });

  it('mirrors label checkpoint as Verification required (no checkpoint name there)', () => {
    expect(MIRROR_FB_STATUS_LABELS.checkpoint).toBe('Verification required');
  });
});
