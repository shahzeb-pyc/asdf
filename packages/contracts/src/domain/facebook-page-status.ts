import { z } from 'zod';
import type { FacebookPageStatus } from './facebook.js';
import { FB_RATE_LIMITED_COOLDOWN_MS } from './facebook-health.js';

/**
 * Facebook page statuses on the Pages + mirrors surfaces (spec 155).
 *
 * The single display definition for the wire `FacebookPageStatus`:
 * badge labels, list filter options, and the detail-page banner.
 * Pages detail (`page-header.tsx`) and mirror detail
 * (`mirror-detail-header.tsx`) both render from here, so the two
 * surfaces cannot drift apart again. Wording is the ADU detail
 * banner wording (PR #190), with one adaptation (owner default 2):
 * ADU says "turn automation on using the toggle" — Pages and
 * mirrors have no toggle, so that phrase reads "turn posting back
 * on" here. Everything else is verbatim.
 *
 * Two deliberate label choices (owner defaults):
 * - `active` stays "Active", NOT ADU's "Active posting" (default 3).
 * - `page_checkpoint` stays "Identity Checkpoint" (default 1) — the
 *   verification-required codes map to the existing checkpoint state
 *   and keep its Mark Verified action; there is no separate
 *   `fb_verification_required` wire value.
 */

export const FB_PAGE_STATUS_LABELS: Record<FacebookPageStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  invalid_token: 'Invalid token',
  page_checkpoint: 'Identity Checkpoint',
  fb_rate_limited: 'Rate limited',
  page_not_accessible: 'Page not accessible',
  missing_page_access: 'Missing page access',
  missing_permission: 'Missing permission',
  check_developer_app: 'Check developer app',
  account_suspended: 'Account suspended',
  '2fa_required_on_BM': 'BM 2FA required',
  disconnected: 'Disconnected',
};

/** The error statuses: every one of them is needs-attention. */
export const FB_ERROR_PAGE_STATUSES: FacebookPageStatus[] = [
  'invalid_token',
  'page_checkpoint',
  'fb_rate_limited',
  'page_not_accessible',
  'missing_page_access',
  'missing_permission',
  'check_developer_app',
  'account_suspended',
  '2fa_required_on_BM',
];

export function isFacebookPageErrorStatus(
  status: string | null | undefined
): boolean {
  return (FB_ERROR_PAGE_STATUSES as string[]).includes(status ?? '');
}

/** Status-filter options for the Pages / mirrors list Selects (ADU hub style, FB-only). */
export const FB_PAGE_STATUS_FILTER_OPTIONS = [
  'All Statuses',
  'Active',
  'Paused',
  'Verification Req.',
  'Rate Limited',
  'Page Not Accessible',
  'Invalid Token',
  '2FA Req. on BM',
  'Check Dev App',
  'Account Suspended',
  'Missing Page Access',
  'Missing Permission',
] as const;

export type FbPageStatusFilterOption =
  (typeof FB_PAGE_STATUS_FILTER_OPTIONS)[number];

/** Filter label -> wire status (null = no narrowing). */
export const FB_PAGE_STATUS_FILTER_TO_WIRE: Record<
  FbPageStatusFilterOption,
  FacebookPageStatus | null
> = {
  'All Statuses': null,
  Active: 'active',
  Paused: 'paused',
  'Verification Req.': 'page_checkpoint',
  'Rate Limited': 'fb_rate_limited',
  'Page Not Accessible': 'page_not_accessible',
  'Invalid Token': 'invalid_token',
  '2FA Req. on BM': '2fa_required_on_BM',
  'Check Dev App': 'check_developer_app',
  'Account Suspended': 'account_suspended',
  'Missing Page Access': 'missing_page_access',
  'Missing Permission': 'missing_permission',
};

/**
 * Status-filter options for the mirrors list Select (spec 155).
 * Same labels as the Pages filter, plus generic `Error` — a mirror
 * in error with no detail anywhere (own or target) displays as
 * Error, and that is the only way to list those.
 */
export const MIRROR_FB_STATUS_FILTER_OPTIONS = [
  'All Statuses',
  'Active',
  'Paused',
  'Error',
  'Verification Req.',
  'Rate Limited',
  'Page Not Accessible',
  'Invalid Token',
  '2FA Req. on BM',
  'Check Dev App',
  'Account Suspended',
  'Missing Page Access',
  'Missing Permission',
] as const;

export type MirrorFbStatusFilterOption =
  (typeof MIRROR_FB_STATUS_FILTER_OPTIONS)[number];

/** Filter label -> `?fbStatus=` value (null = no narrowing). */
export const MIRROR_FB_STATUS_FILTER_TO_VALUE: Record<
  MirrorFbStatusFilterOption,
  'active' | 'paused' | 'error' | MirrorFbStatus | null
> = {
  'All Statuses': null,
  Active: 'active',
  Paused: 'paused',
  Error: 'error',
  'Verification Req.': 'checkpoint',
  'Rate Limited': 'fb_rate_limited',
  'Page Not Accessible': 'page_not_accessible',
  'Invalid Token': 'invalid_token',
  '2FA Req. on BM': '2fa_required_on_BM',
  'Check Dev App': 'check_developer_app',
  'Account Suspended': 'account_suspended',
  'Missing Page Access': 'missing_page_access',
  'Missing Permission': 'missing_permission',
};

export interface FacebookPageStatusAlert {
  title: string;
  description: string;
  variant: 'warning' | 'critical';
  /** Recovery action the surface renders, if any. */
  action: 'mark_verified' | 'reconnect' | null;
}

/**
 * Per-status detail banner. Active, paused and disconnected show no
 * banner (unchanged). Unknown statuses show no banner either — an
 * unexpected value must never invent guidance; the badge already
 * reads as needs-attention.
 *
 * `surface` (owner default 2): the "turn automation on using the
 * toggle" phrase from ADU has no toggle on either surface, so it
 * reads "turn posting back on" on Pages and "Resume posting" on
 * mirrors (the mirror ••• menu's action name). All other text is
 * ADU's verbatim. Pages callers omit the argument.
 */
export function getFacebookPageStatusAlert(
  status: FacebookPageStatus,
  surface: 'pages' | 'mirrors' = 'pages'
): FacebookPageStatusAlert | null {
  const alert = getFacebookPageStatusAlertForPages(status);
  if (alert === null || surface === 'pages') return alert;
  return {
    ...alert,
    description: alert.description.replaceAll('turn posting back on', 'Resume posting'),
  };
}

function getFacebookPageStatusAlertForPages(
  status: FacebookPageStatus
): FacebookPageStatusAlert | null {
  switch (status) {
    case 'active':
    case 'paused':
    case 'disconnected':
      return null;
    case 'invalid_token':
      return {
        title: 'Access Token Expired',
        description:
          'Reconnect your Facebook account in Facebook Accounts. Your page access token has expired or been revoked.',
        variant: 'critical',
        action: 'reconnect',
      };
    case 'page_checkpoint':
      return {
        title: 'Facebook Verification Required',
        description:
          'Complete identity or phone verification in the Meta app on your mobile device. This is not a token error — do not reconnect. After verification, turn posting back on.',
        variant: 'critical',
        action: 'mark_verified',
      };
    case 'fb_rate_limited':
      return {
        title: 'Facebook Rate Limited',
        description:
          'Meta is limiting how often this page can post. Automation pauses for about 3 days and will resume automatically when the cooldown ends.',
        variant: 'critical',
        action: null,
      };
    case 'page_not_accessible':
      return {
        title: 'Facebook Page Not Accessible',
        description:
          'This page may have been removed, or your account may no longer have access to it. Confirm the page still exists and reconnect your Facebook account if needed, then turn posting back on.',
        variant: 'critical',
        action: 'reconnect',
      };
    case 'missing_page_access':
      return {
        title: 'Missing Page Access',
        description:
          'Your account no longer has a role on this page, so posting is paused. Ask an admin to restore your role in Business Manager, then turn posting back on.',
        variant: 'critical',
        action: null,
      };
    case 'missing_permission':
      return {
        title: 'Missing Permission',
        description:
          'A permission this page needs is missing, so posting is paused. Ask an admin to grant the permission, then turn posting back on.',
        variant: 'critical',
        action: null,
      };
    case 'check_developer_app':
      return {
        title: 'Developer App Access Blocked',
        description:
          'Access is blocked for this page. Fix the problem in your developer app, then turn posting back on. Posting stays paused until then.',
        variant: 'critical',
        action: null,
      };
    case 'account_suspended':
      return {
        title: 'Facebook Account Suspended',
        description:
          'The connected Facebook account is suspended. Once Facebook clears the restriction, turn posting back on.',
        variant: 'critical',
        action: null,
      };
    case '2fa_required_on_BM':
      return {
        title: 'Business 2FA Required',
        description:
          'The connected Facebook account must have an admin, editor, or moderator role on this page, and Business Manager two-factor authentication must be complete. Once that is done, turn posting back on.',
        variant: 'critical',
        action: null,
      };
    default:
      return null;
  }
}

/**
 * The values `metadata.fb_status` may carry on a destinations row
 * (spec 155): the detail marker for a Facebook error status, plus
 * `checkpoint` (the stored spelling of `page_checkpoint`) and
 * `paused` (the stored spelling of `paused`). The read mapping
 * (`unifiedDestinationStatusToWire`) turns the marker back into the
 * wire status; the write side is `destinationFbStatusMarker` below.
 */
export const DESTINATION_FB_STATUS_MARKERS = [
  'checkpoint',
  'paused',
  'invalid_token',
  'page_not_accessible',
  'missing_page_access',
  'missing_permission',
  'check_developer_app',
  'account_suspended',
  '2fa_required_on_BM',
] as const;
export type DestinationFbStatusMarker =
  (typeof DESTINATION_FB_STATUS_MARKERS)[number];

/**
 * A Pages wire status -> the `metadata.fb_status` marker that stores
 * it, or null when the status carries no marker (the marker must be
 * cleared). `active` and `fb_rate_limited` clear: rate-limited rows
 * carry their anchor in `rate_limited_at`, not in the marker.
 */
export function destinationFbStatusMarker(
  pageStatus: FacebookPageStatus | null | undefined
): DestinationFbStatusMarker | null {
  switch (pageStatus) {
    case 'page_checkpoint':
      return 'checkpoint';
    case 'invalid_token':
    case 'page_not_accessible':
    case 'missing_page_access':
    case 'missing_permission':
    case 'check_developer_app':
    case 'account_suspended':
    case '2fa_required_on_BM':
      return pageStatus;
    default:
      return null;
  }
}

/**
 * Mirrors store the Facebook detail separately from their own
 * `active` / `paused` / `error` status (`mirrors.fb_status`):
 * the detail is one of these values, or null when there is none.
 * `checkpoint` is the mirror spelling of the Pages wire value
 * `page_checkpoint` (mirrors never had a checkpoint name, so the
 * ADU wording applies there).
 */
export const MIRROR_FB_STATUSES = [
  'checkpoint',
  'invalid_token',
  'fb_rate_limited',
  'page_not_accessible',
  'missing_page_access',
  'missing_permission',
  'check_developer_app',
  'account_suspended',
  '2fa_required_on_BM',
] as const;
export type MirrorFbStatus = (typeof MIRROR_FB_STATUSES)[number];
export const MirrorFbStatusSchema = z.enum(MIRROR_FB_STATUSES);

export const MIRROR_FB_STATUS_LABELS: Record<MirrorFbStatus, string> = {
  checkpoint: 'Verification required',
  invalid_token: 'Invalid token',
  fb_rate_limited: 'Rate limited',
  page_not_accessible: 'Page not accessible',
  missing_page_access: 'Missing page access',
  missing_permission: 'Missing permission',
  check_developer_app: 'Check developer app',
  account_suspended: 'Account suspended',
  '2fa_required_on_BM': 'BM 2FA required',
};

/**
 * A Pages wire status -> the mirror `fb_status` value that means
 * the same thing. `active` (and anything without a Facebook error)
 * maps to null: no detail stored. `page_checkpoint` maps to
 * `checkpoint`; the rest pass through unchanged.
 */
export function mirrorFbStatusFromPageStatus(
  pageStatus: FacebookPageStatus | null | undefined
): MirrorFbStatus | null {
  switch (pageStatus) {
    case 'page_checkpoint':
      return 'checkpoint';
    case 'invalid_token':
    case 'fb_rate_limited':
    case 'page_not_accessible':
    case 'missing_page_access':
    case 'missing_permission':
    case 'check_developer_app':
    case 'account_suspended':
    case '2fa_required_on_BM':
      return pageStatus;
    default:
      return null;
  }
}

/** Mirror `fb_status` -> the wire status it displays as. */
export function pageStatusFromMirrorFbStatus(
  fbStatus: string | null | undefined
): FacebookPageStatus | null {
  switch (fbStatus) {
    case 'checkpoint':
      return 'page_checkpoint';
    case 'invalid_token':
    case 'fb_rate_limited':
    case 'page_not_accessible':
    case 'missing_page_access':
    case 'missing_permission':
    case 'check_developer_app':
    case 'account_suspended':
    case '2fa_required_on_BM':
      return fbStatus;
    default:
      return null;
  }
}

/**
 * What a mirror displays as, from its stored state plus its target
 * destination's Facebook detail (spec 155). Facebook-target mirrors
 * only — Instagram-target mirrors keep today's rendering exactly and
 * never reach this function.
 *
 *   active / paused            -> themselves
 *   error + own fb_status      -> that status
 *   error + no fb_status, but the Facebook target destination
 *     carries an FB error detail -> the target's status
 *   error + neither            -> generic `error` (today's behaviour)
 *
 * A rate-limited mirror whose 3-day anchor is stale reads as
 * `active` — the Pages read-time rule (`evaluatePageHealth` flips
 * a stale rate-limited page to active) applied to mirrors, so the
 * card never shows a cooldown that has already ended while the
 * tick has not run yet. The tick itself clears the stored value on
 * the next check; this is display-only.
 */
export type MirrorDisplayStatus = 'active' | 'paused' | 'error' | MirrorFbStatus;

export function resolveMirrorDisplayStatus(input: {
  status: string;
  fbStatus?: MirrorFbStatus | string | null;
  fbRateLimitedAt?: string | null;
  targetFbStatus?: MirrorFbStatus | string | null;
  now?: Date;
}): MirrorDisplayStatus {
  if (input.status === 'active') return 'active';
  if (input.status === 'paused') return 'paused';
  if (input.status !== 'error') return 'error';
  const own = pageStatusFromMirrorFbStatus(
    typeof input.fbStatus === 'string' ? input.fbStatus : null
  );
  if (own === 'fb_rate_limited') {
    const anchor = input.fbRateLimitedAt ? Date.parse(input.fbRateLimitedAt) : Number.NaN;
    const nowMs = input.now ? input.now.getTime() : Date.now();
    if (!Number.isNaN(anchor) && nowMs - anchor >= FB_RATE_LIMITED_COOLDOWN_MS) {
      return 'active';
    }
    return 'fb_rate_limited';
  }
  if (own !== null) return mirrorFbStatusFromPageStatus(own) ?? 'error';
  const target = pageStatusFromMirrorFbStatus(
    typeof input.targetFbStatus === 'string' ? input.targetFbStatus : null
  );
  if (target !== null) return mirrorFbStatusFromPageStatus(target) ?? 'error';
  return 'error';
}

/** Display label for a resolved mirror status (`error` -> "Error"). */
export function getMirrorDisplayStatusLabel(status: MirrorDisplayStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Error';
    default:
      return MIRROR_FB_STATUS_LABELS[status];
  }
}
