/**
 * Facebook active-account restriction detection — the single source for
 * every feature that surfaces a Facebook publish failure.
 *
 * The restriction is account-level: Meta returns Graph code 1 with subcode
 * 2424009 or 1404078, and retrying cannot work until the restriction is
 * lifted. Publish Now previously carried this check locally in two places
 * (its route and its page); Auto Repost imports it from here so the
 * subcode list never drifts between features.
 *
 * Each feature keeps its own approved user-facing copy — this module only
 * decides WHETHER an error is a restriction. The Auto Repost copy lives in
 * MIRROR_FACEBOOK_RESTRICTED_MESSAGE below; Publish Now keeps its own
 * approved copy in its route.
 */

/** Graph subcodes for Meta's active account restriction (Graph code 1). */
export const FACEBOOK_ACCOUNT_RESTRICTION_SUBCODES = [2424009, 1404078] as const;

/**
 * Approved Auto Repost wording for a restriction, shown wherever a mirror
 * publish failure surfaces (setup immediate post, mirror error banner,
 * post history rows). The raw Facebook detail stays in server/worker logs
 * for debugging and is never shown as the headline message.
 */
export const MIRROR_FACEBOOK_RESTRICTED_MESSAGE =
  "This Facebook page can't post right now because the connected account is temporarily restricted on Facebook. It should work again once the restriction lifts — check Facebook Account Status for details.";

interface FacebookErrorFields {
  code?: unknown;
  subcode?: unknown;
  error_subcode?: unknown;
  errorSubcode?: unknown;
  message?: unknown;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readFields(error: unknown): FacebookErrorFields {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return {};
  }
  return error as FacebookErrorFields;
}

/**
 * True when the error is Meta's active account restriction.
 *
 * Primary signal is structured: Graph code 1 with a restriction subcode
 * (accepted under `subcode`, `error_subcode`, or `errorSubcode`, since
 * the web reel client, the worker Graph client, and the Publish Now route
 * each name the field differently).
 *
 * Narrow fallback (on by default): when neither a code nor a subcode
 * survives (an error that carries the restriction only as free text, e.g.
 * a user_message), the distinctive phrase "limited access" still counts
 * as a restriction. The phrase is specific to the account-restriction
 * notice; generic failures (rate limits, auth, duplicates) do not contain
 * it. Callers that must keep exact historical semantics (Publish Now)
 * pass `{ messageFallback: false }` to use structured codes only.
 */
export function isFacebookAccountRestricted(
  error: unknown,
  opts?: { messageFallback?: boolean }
): boolean {
  const fields = readFields(error);
  const code = finiteNumber(fields.code);
  const subcode =
    finiteNumber(fields.subcode) ??
    finiteNumber(fields.error_subcode) ??
    finiteNumber(fields.errorSubcode);
  if (
    code === 1 &&
    subcode !== undefined &&
    (FACEBOOK_ACCOUNT_RESTRICTION_SUBCODES as readonly number[]).includes(subcode)
  ) {
    return true;
  }
  if (opts?.messageFallback === false) return false;
  // The fallback runs ONLY when no structured signal survived: a code
  // or subcode that is present but does not match is a definite
  // non-restriction, not an invitation to re-classify via free text.
  if (code !== undefined || subcode !== undefined) return false;
  const message = typeof fields.message === 'string' ? fields.message : '';
  return message.toLowerCase().includes('limited access');
}
