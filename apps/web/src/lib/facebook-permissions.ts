/**
 * Facebook account-connect scope check (Facebook App settings fixes).
 *
 * The connect initiators request exactly these five scopes; the
 * callback must refuse to save an account that did not grant all of
 * them. This module is pure (no fetch, no DB) so the comparison and
 * the user-facing copy are unit-testable: the callback owns the
 * Graph call, this module owns what "granted" means and how a
 * rejection reads.
 *
 * A scope counts as granted only when /me/permissions lists it with
 * status "granted". A scope that is absent from the list, or listed
 * as "declined" (or anything else), is missing — there is no
 * fail-open: an unknown status never counts as granted.
 */

export const REQUIRED_FACEBOOK_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'pages_manage_engagement',
  'business_management',
] as const;

export type RequiredFacebookScope = (typeof REQUIRED_FACEBOOK_SCOPES)[number];

/** Plain-language name for each scope, used in the rejection banner. */
export const FACEBOOK_SCOPE_PLAIN_NAMES: Record<RequiredFacebookScope, string> = {
  pages_show_list: 'viewing your Pages',
  pages_read_engagement: 'reading Page engagement',
  pages_manage_posts: 'posting to Pages',
  pages_manage_engagement: 'managing Page engagement',
  business_management: 'managing your business',
};

export interface FacebookPermissionEntry {
  permission?: unknown;
  status?: unknown;
}

function isRequiredScope(value: unknown): value is RequiredFacebookScope {
  return (
    typeof value === 'string' &&
    (REQUIRED_FACEBOOK_SCOPES as readonly string[]).includes(value)
  );
}

/**
 * Scopes from the required five that are not granted in the
 * /me/permissions list. Entries for other permissions are ignored;
 * duplicates do not change the result.
 */
export function findMissingScopes(
  permissions: readonly FacebookPermissionEntry[] | null | undefined
): RequiredFacebookScope[] {
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
  return REQUIRED_FACEBOOK_SCOPES.filter((scope) => !granted.has(scope));
}

/** Keep only recognised scope names from a redirect `missing` param. */
export function parseMissingScopesParam(
  value: string | null | undefined
): RequiredFacebookScope[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(isRequiredScope);
}

/**
 * The professional rejection banner. The actually missing scope is
 * named in plain language — never just "posting" — and multiple
 * missing scopes are all named.
 */
export function buildScopeRejectionMessage(
  missing: readonly RequiredFacebookScope[]
): string {
  const names = missing.map((scope) => FACEBOOK_SCOPE_PLAIN_NAMES[scope]);
  if (names.length === 0) {
    return 'This Facebook account was not connected. A required permission was declined. Please reconnect and allow all requested permissions to continue.';
  }
  if (names.length === 1) {
    return `This Facebook account was not connected. A required permission — ${names[0]} — was declined. Please reconnect and allow all requested permissions to continue.`;
  }
  const allButLast = names.slice(0, -1).join(', ');
  const last = names[names.length - 1];
  return `This Facebook account was not connected. Required permissions — ${allButLast} and ${last} — were declined. Please reconnect and allow all requested permissions to continue.`;
}

/**
 * Pull the permission entries out of a /me/permissions payload.
 * Anything malformed yields an empty list (the caller treats an
 * unusable check as unknown, never as granted).
 */
export function parseFacebookPermissions(
  payload: unknown
): FacebookPermissionEntry[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.filter(
    (entry): entry is FacebookPermissionEntry =>
      Boolean(entry) && typeof entry === 'object'
  );
}
