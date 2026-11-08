import type { AduConfigStatus } from './adu.js';

/**
 * ADU publish-error mapper (spec §3.1 — the mapping table is the
 * contract). Pure: given the error facts from a failed publish
 * attempt, decide the ADU-side effects. Branch on the top-level
 * `code` first, subcodes as refinements; message text only refines
 * the 368 security / developer-app rows and the page-gone signal.
 *
 * This is the single ADU decision point: the worker tick applies
 * this decision and nothing else (it does NOT read the publisher
 * outcome's `targetDestinationStatus` / `targetAccountStatus` —
 * those belong to the Pages queue settle path). Retry disposition is
 * deliberately NOT part of this decision — the publisher and the
 * tick's retry budget own it.
 *
 * `userMessage: 'generic-backend'` is for the two app-bug codes
 * (190/2069032, 3): the user sees only {@link ADU_GENERIC_BACKEND_MESSAGE}
 * and the full detail goes to the team log. Every other code shows
 * the user the real reason.
 */
export interface AduPublishErrorInput {
  /** Graph error code, as stored on the job row (`outcome.error.code`). */
  code: string | number | null | undefined;
  /** Graph error subcode, as stored on the job row. */
  subcode: string | number | null | undefined;
  /** Raw error message (Graph message, or the stored reason). */
  message?: string | null | undefined;
  /** HTTP status from the publish diagnostic (`outcome.detail.httpStatus`). */
  httpStatus?: number | null | undefined;
}

export interface AduPublishErrorDecision {
  /** Config status to set, or null when the config keeps its status. */
  aduStatus: AduConfigStatus | null;
  /** True only for invalid_token: flip the account + sibling pages. */
  cascadeInvalidToken: boolean;
  /** Destination status to set, or null when it keeps its status. */
  destinationStatus: 'error' | 'rate_limited' | null;
  /** Account status to set, or null when it keeps its status. */
  accountStatus: 'expired' | null;
  /** Which message the user sees for this failure. */
  userMessage: 'real' | 'generic-backend';
}

/** The only user-visible message for the two app-bug codes. */
export const ADU_GENERIC_BACKEND_MESSAGE =
  'This post could not be published because of a backend issue.';

const CHECK_DEVELOPER_APP_SUBCODES = new Set([2069030, 2069031, 2069033]);
const VOLUME_RATE_LIMIT_CODES = new Set([4, 32, 341, 613, 80001]);
const TRANSIENT_CODES = new Set([1, 2, 17, 500, 502, 503]);
const BODY_LESS_HTTP_STATUSES = new Set([400, 401, 403, 413, 429]);

function parseNumeric(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

/** `http_404` (the publisher's code for a body-less HTTP failure). */
function parseHttpCode(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'string') {
    const match = /^http_(\d+)$/.exec(value.trim());
    if (match) return Number.parseInt(match[1]!, 10);
  }
  return undefined;
}

function noFlip(userMessage: 'real' | 'generic-backend' = 'real'): AduPublishErrorDecision {
  return {
    aduStatus: null,
    cascadeInvalidToken: false,
    destinationStatus: null,
    accountStatus: null,
    userMessage,
  };
}

function statusOnly(aduStatus: AduConfigStatus): AduPublishErrorDecision {
  return {
    aduStatus,
    cascadeInvalidToken: false,
    destinationStatus: null,
    accountStatus: null,
    userMessage: 'real',
  };
}

function invalidToken(): AduPublishErrorDecision {
  return {
    aduStatus: 'invalid_token',
    cascadeInvalidToken: true,
    destinationStatus: 'error',
    accountStatus: 'expired',
    userMessage: 'real',
  };
}

function verificationRequired(): AduPublishErrorDecision {
  return {
    aduStatus: 'fb_verification_required',
    cascadeInvalidToken: false,
    destinationStatus: 'error',
    accountStatus: null,
    userMessage: 'real',
  };
}

function rateLimited(): AduPublishErrorDecision {
  return {
    aduStatus: 'fb_rate_limited',
    cascadeInvalidToken: false,
    destinationStatus: 'rate_limited',
    accountStatus: null,
    userMessage: 'real',
  };
}

export function evaluateAduPublishError(
  input: AduPublishErrorInput,
): AduPublishErrorDecision {
  const code = parseNumeric(input.code);
  const subcode = parseNumeric(input.subcode);
  const message = (input.message ?? '').toLowerCase();
  const httpStatus =
    parseHttpCode(input.code) ?? (typeof input.httpStatus === 'number' ? input.httpStatus : undefined);

  if (code !== undefined) {
    // 190 — token family. Subcodes refine; 483 has no documented
    // meaning and falls to the generic 190 branch (invalid_token).
    if (code === 190) {
      if (subcode === 459 || subcode === 464) return verificationRequired();
      if (subcode === 492) return statusOnly('missing_page_access');
      if (subcode === 2069031) return statusOnly('check_developer_app');
      if (subcode === 2069032) return noFlip('generic-backend');
      return invalidToken();
    }

    if (code === 102) return invalidToken();

    // 368 — policy / checkpoint family; the subcode decides everything.
    if (code === 368) {
      if (subcode === 4854002 || subcode === 1404078) return verificationRequired();
      if (subcode === 1390008) return rateLimited();
      if (subcode === 1404102 || subcode === 1404082) return noFlip();
      if (subcode === 1404112) return statusOnly('account_suspended');
      if (message.includes('suspended') || message.includes('disabled')) {
        return statusOnly('account_suspended');
      }
      if (message.includes('developer app') || message.includes('app is restricted')) {
        return statusOnly('check_developer_app');
      }
      return rateLimited();
    }

    // 400 — the checkpoint arrives here too (400/4854002); anything
    // else with a numeric 400 is a body-less-style failure: no status.
    if (code === 400) {
      if (subcode === 4854002) return verificationRequired();
      return noFlip();
    }

    // 10 / 200–299 — permission family, not a dead token. The
    // 206903x subcodes and the "API access blocked" text are the
    // developer-app signal instead.
    if (code === 10 || (code >= 200 && code <= 299)) {
      if (subcode !== undefined && CHECK_DEVELOPER_APP_SUBCODES.has(subcode)) {
        return statusOnly('check_developer_app');
      }
      if (code === 200 && message.includes('api access blocked')) {
        return statusOnly('check_developer_app');
      }
      return statusOnly('missing_permission');
    }

    // Content codes: the post is at fault, the page stays active.
    if (code === 506 || code === 382 || code === 1363040) return noFlip();
    // Content codes with retry ×2 (publisher-owned): no status.
    if (code === 100 || code === 1609005) return noFlip();
    // Transient codes (retry ×5, tick budget): no status.
    if (TRANSIENT_CODES.has(code)) return noFlip();
    // Volume rate limits (retry with backoff): no status.
    if (
      VOLUME_RATE_LIMIT_CODES.has(code) ||
      (code >= 80000 && code <= 80014)
    ) {
      return noFlip();
    }
    // App bug: no status, no retry, generic backend message only.
    if (code === 3) return noFlip('generic-backend');

    return noFlip();
  }

  // No numeric Graph code: HTTP-level signals only.
  if (
    httpStatus === 404 ||
    message.includes('page not found') ||
    message.includes('does not exist')
  ) {
    return statusOnly('page_not_accessible');
  }
  if (httpStatus !== undefined && BODY_LESS_HTTP_STATUSES.has(httpStatus)) {
    return noFlip();
  }
  return noFlip();
}
