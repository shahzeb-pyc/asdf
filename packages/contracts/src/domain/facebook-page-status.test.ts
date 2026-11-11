/**
 * Spec 155: the shared Pages/mirrors display definition. The badge
 * labels, the filter mapping, the detail banner, and the mirror
 * detail mapping are pinned here so the two surfaces cannot drift.
 */
import { describe, expect, it } from 'vitest';
import {
  destinationFbStatusMarker,
  FB_PAGE_STATUS_FILTER_TO_WIRE,
  FB_PAGE_STATUS_LABELS,
  getFacebookPageStatusAlert,
  getMirrorDisplayStatusLabel,
  isFacebookPageErrorStatus,
  MIRROR_FB_STATUS_FILTER_TO_VALUE,
  MIRROR_FB_STATUS_LABELS,
  mirrorFbStatusFromPageStatus,
  pageStatusFromMirrorFbStatus,
  resolveMirrorDisplayStatus,
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

  it('spec 164: the three polished descriptions read plainly, no jargon', () => {
    expect(getFacebookPageStatusAlert('fb_rate_limited')?.description).toBe(
      'Facebook is limiting how often this page can post. Posting pauses for about 3 days and starts again on its own when the limit lifts.',
    );
    expect(getFacebookPageStatusAlert('check_developer_app')?.description).toBe(
      "Facebook has blocked this page in the developer app. Check the app's access settings, then turn posting back on.",
    );
    expect(getFacebookPageStatusAlert('2fa_required_on_BM')?.description).toBe(
      'Turn on two-factor authentication in Business Manager, and make sure the connected account has an admin, editor, or moderator role on this page. Then turn posting back on.',
    );
    // None of the three names jargon or a vague "fix the problem".
    for (const status of ['fb_rate_limited', 'check_developer_app', '2fa_required_on_BM'] as const) {
      const description = getFacebookPageStatusAlert(status)?.description ?? '';
      expect(description).not.toContain('cooldown');
      expect(description).not.toContain('Fix the problem');
    }
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

  it('destinationFbStatusMarker: detail statuses set, active/rate-limited clear', () => {
    expect(destinationFbStatusMarker('page_checkpoint')).toBe('checkpoint');
    expect(destinationFbStatusMarker('missing_permission')).toBe('missing_permission');
    expect(destinationFbStatusMarker('account_suspended')).toBe('account_suspended');
    expect(destinationFbStatusMarker('active')).toBeNull();
    expect(destinationFbStatusMarker('fb_rate_limited')).toBeNull();
    expect(destinationFbStatusMarker('paused')).toBeNull();
    expect(destinationFbStatusMarker(undefined)).toBeNull();
  });
});

describe('getFacebookPageStatusAlert mirrors wording — spec 155', () => {
  it('mirrors say "resume posting" where Pages say "turn posting back on"', () => {
    for (const status of [
      'page_checkpoint',
      'page_not_accessible',
      'missing_page_access',
      'missing_permission',
      'check_developer_app',
      'account_suspended',
      '2fa_required_on_BM',
    ] as const) {
      const alert = getFacebookPageStatusAlert(status, 'mirrors');
      expect(alert).not.toBeNull();
      expect(alert?.description).toContain('resume posting');
      expect(alert?.description).not.toContain('Resume posting');
      expect(alert?.description).not.toContain('turn posting back on');
      expect(alert?.description).not.toContain('toggle');
    }
  });

  it('Pages wording is unchanged by default', () => {
    const alert = getFacebookPageStatusAlert('missing_permission');
    expect(alert?.description).toContain('turn posting back on');
  });

  it('the mirrors banner keeps the same title, variant and action as Pages', () => {
    expect(getFacebookPageStatusAlert('invalid_token', 'mirrors')?.action).toBe('reconnect');
    expect(getFacebookPageStatusAlert('page_checkpoint', 'mirrors')?.action).toBe(
      'mark_verified'
    );
    expect(getFacebookPageStatusAlert('fb_rate_limited', 'mirrors')?.action).toBeNull();
    expect(getFacebookPageStatusAlert('active', 'mirrors')).toBeNull();
  });
});

describe('resolveMirrorDisplayStatus — spec 155', () => {
  it('active and paused pass through', () => {
    expect(resolveMirrorDisplayStatus({ status: 'active' })).toBe('active');
    expect(resolveMirrorDisplayStatus({ status: 'paused' })).toBe('paused');
  });

  it('error + own fb_status shows that status', () => {
    expect(
      resolveMirrorDisplayStatus({ status: 'error', fbStatus: 'missing_permission' })
    ).toBe('missing_permission');
    expect(resolveMirrorDisplayStatus({ status: 'error', fbStatus: 'checkpoint' })).toBe(
      'checkpoint'
    );
  });

  it('error + no own detail falls back to the target destination detail', () => {
    expect(
      resolveMirrorDisplayStatus({
        status: 'error',
        fbStatus: null,
        targetFbStatus: 'account_suspended',
      })
    ).toBe('account_suspended');
  });

  it('error + neither detail is generic Error; own detail beats the target', () => {
    expect(resolveMirrorDisplayStatus({ status: 'error' })).toBe('error');
    expect(
      resolveMirrorDisplayStatus({
        status: 'error',
        fbStatus: 'invalid_token',
        targetFbStatus: 'missing_permission',
      })
    ).toBe('invalid_token');
  });

  it('a rate-limited mirror with a stale anchor reads as Active', () => {
    const now = new Date('2026-11-09T16:00:00.000Z');
    expect(
      resolveMirrorDisplayStatus({
        status: 'error',
        fbStatus: 'fb_rate_limited',
        fbRateLimitedAt: '2026-11-05T15:59:00.000Z',
        now,
      })
    ).toBe('active');
    // Fresh anchor: still rate-limited.
    expect(
      resolveMirrorDisplayStatus({
        status: 'error',
        fbStatus: 'fb_rate_limited',
        fbRateLimitedAt: '2026-11-08T16:00:00.000Z',
        now,
      })
    ).toBe('fb_rate_limited');
  });

  it('an unknown stored status reads as Error, never healthy', () => {
    expect(resolveMirrorDisplayStatus({ status: 'bogus' })).toBe('error');
  });

  it('display labels: Active kept, checkpoint is Verification required, error is Error', () => {
    expect(getMirrorDisplayStatusLabel('active')).toBe('Active');
    expect(getMirrorDisplayStatusLabel('checkpoint')).toBe('Verification required');
    expect(getMirrorDisplayStatusLabel('error')).toBe('Error');
    expect(getMirrorDisplayStatusLabel('fb_rate_limited')).toBe('Rate limited');
  });
});

describe('MIRROR_FB_STATUS_FILTER_TO_VALUE — spec 155', () => {
  it('maps every filter label to its ?fbStatus= value', () => {
    expect(MIRROR_FB_STATUS_FILTER_TO_VALUE['All Statuses']).toBeNull();
    expect(MIRROR_FB_STATUS_FILTER_TO_VALUE.Active).toBe('active');
    expect(MIRROR_FB_STATUS_FILTER_TO_VALUE.Paused).toBe('paused');
    expect(MIRROR_FB_STATUS_FILTER_TO_VALUE.Error).toBe('error');
    expect(MIRROR_FB_STATUS_FILTER_TO_VALUE['Verification Req.']).toBe('checkpoint');
    expect(MIRROR_FB_STATUS_FILTER_TO_VALUE['Rate Limited']).toBe('fb_rate_limited');
    expect(MIRROR_FB_STATUS_FILTER_TO_VALUE['Invalid Token']).toBe('invalid_token');
    expect(MIRROR_FB_STATUS_FILTER_TO_VALUE['Missing Permission']).toBe(
      'missing_permission'
    );
  });
});
