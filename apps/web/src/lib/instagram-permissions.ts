/**
 * Instagram Unified Login scope check (pure, no fetch, no DB).
 *
 * The connect flow requests exactly the four Unified Login permissions
 * in INSTAGRAM_UNIFIED_OAUTH_SCOPES (contracts, single source of truth).
 * The callback must refuse to save accounts that did not grant all of
 * them. This module owns what "granted" means and how a rejection reads;
 * the callback owns the Graph call. It mirrors the Facebook permissions
 * module (Facebook PR 113) so the two flows can never drift in semantics.
 *
 * A scope counts as granted only when /me/permissions lists it with
 * status "granted". A scope that is absent, declined, or listed with any
 * other status is missing — an unknown status never counts as granted.
 */

import { INSTAGRAM_UNIFIED_OAUTH_SCOPES } from '@fbuploadpro/contracts';

export const REQUIRED_INSTAGRAM_UNIFIED_SCOPES = INSTAGRAM_UNIFIED_OAUTH_SCOPES;

export type RequiredInstagramUnifiedScope =
  (typeof INSTAGRAM_UNIFIED_OAUTH_SCOPES)[number];

/** Plain-language name for each scope, used in the rejection banner. */
export const INSTAGRAM_UNIFIED_SCOPE_PLAIN_NAMES: Record<
  RequiredInstagramUnifiedScope,
  string
> = {
  instagram_basic: 'reading your profile and media',
  instagram_content_publish: 'publishing posts and reels',
  instagram_manage_comments: 'managing comments',
  instagram_manage_insights: 'viewing insights',
};

export interface InstagramPermissionEntry {
  permission?: unknown;
  status?: unknown;
}

function isRequiredScope(value: unknown): value is RequiredInstagramUnifiedScope {
  return (
    typeof value === 'string' &&
    (INSTAGRAM_UNIFIED_OAUTH_SCOPES as readonly string[]).includes(value)
  );
}

/** Scopes from the required four that are not granted in the list. */
export function findMissingInstagramScopes(
  permissions: readonly InstagramPermissionEntry[] | null | undefined
): RequiredInstagramUnifiedScope[] {
  const granted = new Set<string>();
  if (Array.isArray(permissions)) {
    for (const entry of permissions) {
      if (
        entry &&
        typeof entry.permission === 'string' &&
        entry.status === 'granted'
      ) {
        granted.add(entry.permission);
      }
    }
  }
  return INSTAGRAM_UNIFIED_OAUTH_SCOPES.filter((scope) => !granted.has(scope));
}

/** Keep only recognised scope names from a redirect `missing` param. */
export function parseMissingInstagramScopesParam(
  value: string | null | undefined
): RequiredInstagramUnifiedScope[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(isRequiredScope);
}

/** The professional rejection banner for Instagram, naming the missing scopes. */
export function buildInstagramScopeRejectionMessage(
  missing: readonly RequiredInstagramUnifiedScope[]
): string {
  const names = missing.map(
    (scope) => INSTAGRAM_UNIFIED_SCOPE_PLAIN_NAMES[scope]
  );
  if (names.length === 0) {
    return 'This Instagram account was not connected. A required permission was declined. Please reconnect and allow all requested permissions to continue.';
  }
  if (names.length === 1) {
    return `This Instagram account was not connected. A required permission — ${names[0]} — was declined. Please reconnect and allow all requested permissions to continue.`;
  }
  const allButLast = names.slice(0, -1).join(', ');
  const last = names[names.length - 1];
  return `This Instagram account was not connected. Required permissions — ${allButLast} and ${last} — were declined. Please reconnect and allow all requested permissions to continue.`;
}

/**
 * Pull the permission entries out of a /me/permissions payload.
 * Anything malformed yields an empty list (the caller treats an
 * unusable check as unknown, never as granted).
 */
export function parseInstagramPermissions(
  payload: unknown
): InstagramPermissionEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (entry): entry is InstagramPermissionEntry =>
      Boolean(entry) && typeof entry === 'object'
  );
}
