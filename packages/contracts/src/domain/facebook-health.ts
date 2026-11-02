import type { FacebookAccountStatus, FacebookPageStatus } from './facebook.js';

export const FB_RATE_LIMITED_COOLDOWN_DAYS = 3;
export const FB_RATE_LIMITED_COOLDOWN_MS =
  FB_RATE_LIMITED_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

export interface GraphApiErrorEvaluation {
  accountStatus: FacebookAccountStatus;
  pageStatus: FacebookPageStatus;
  isTransient: boolean;
  requiresReauth: boolean;
  requiresManualVerification?: boolean;
  message: string;
}

/**
 * Maps Facebook Graph API error codes and subcodes to internal domain health states.
 * - Error 190 / 102 (with subcodes 458, 459, 460, 463, 464, 467, 483, 492 or general): maps to expired / invalid_token, requiring re-auth.
 * - Error 10 / 200-299: maps to expired / invalid_token, requiring re-auth.
 * - Error 368:
 *   - Subcode 1390008 (or default 368): "We limit how often you can post, comment or do other things..." -> maps pageStatus to 'fb_rate_limited' with 3-day auto-recovery to 'active'.
 *   - Subcode 4854002: "Confirm your identity before you can publish as this Page." -> maps pageStatus to 'page_checkpoint' (requires user mobile login & verification, then manual reactivation).
 *   - Subcode 1404082: "You've already posted this. Posting the same content repeatedly..." -> keeps pageStatus 'active', marks post as failed (isTransient: false) with reason.
 * - Error 506: Duplicate post -> keeps pageStatus 'active', marks post as failed (isTransient: false) with duplicate reason.
 * - Error 1609005: Bad/unreachable link -> keeps pageStatus 'active', marks post as failed (isTransient: false) with bad link reason.
 * - Error 4, 17, 32, 341, 613, 80000-80014 (API call volume rate limits): keeps accountStatus and pageStatus 'active' with isTransient: true.
 */
export function evaluateGraphApiError(
  code: number,
  errorSubcode?: number
): GraphApiErrorEvaluation | null {
  if (code === 190 || code === 102) {
    if (errorSubcode === 458) {
      return {
        accountStatus: 'expired',
        pageStatus: 'invalid_token',
        isTransient: false,
        requiresReauth: true,
        message: 'Application authorization was revoked by the user.',
      };
    }
    if (errorSubcode === 460) {
      return {
        accountStatus: 'expired',
        pageStatus: 'invalid_token',
        isTransient: false,
        requiresReauth: true,
        message: 'User password changed or session was invalidated.',
      };
    }
    if (errorSubcode === 463) {
      return {
        accountStatus: 'expired',
        pageStatus: 'invalid_token',
        isTransient: false,
        requiresReauth: true,
        message: 'Access token has expired.',
      };
    }
    if (errorSubcode === 492) {
      return {
        accountStatus: 'active',
        pageStatus: 'invalid_token',
        isTransient: false,
        requiresReauth: true,
        message:
          'User associated with the Page access token does not have an appropriate role on the Page.',
      };
    }
    return {
      accountStatus: 'expired',
      pageStatus: 'invalid_token',
      isTransient: false,
      requiresReauth: true,
      message: 'Access token is invalid or revoked.',
    };
  }

  // Error 10 or 200-299: Facebook Permission / Authorization Denied
  if (code === 10 || (code >= 200 && code <= 299)) {
    return {
      accountStatus: 'expired',
      pageStatus: 'invalid_token',
      isTransient: false,
      requiresReauth: true,
      message: 'Facebook permission or authorization denied. Please re-authenticate your account.',
    };
  }

  // Error 506: Duplicate Post
  if (code === 506) {
    return {
      accountStatus: 'active',
      pageStatus: 'active',
      isTransient: false,
      requiresReauth: false,
      message: 'This post is identical to the one previously shared and was rejected as duplicate.',
    };
  }

  // Error 1609005: Bad Link URL
  if (code === 1609005) {
    return {
      accountStatus: 'active',
      pageStatus: 'active',
      isTransient: false,
      requiresReauth: false,
      message: 'The provided link URL cannot be loaded or is unreachable by Facebook.',
    };
  }

  // Error 368: Facebook Page Policy / Action Restriction Subcodes
  if (code === 368) {
    // Subcode 4854002: "Confirm your identity before you can publish as this Page."
    if (errorSubcode === 4854002) {
      return {
        accountStatus: 'active',
        pageStatus: 'page_checkpoint',
        isTransient: false,
        requiresReauth: false,
        requiresManualVerification: true,
        message:
          'Confirm your identity before you can publish as this Page. Please log in to Facebook on a mobile device, switch to this Page, confirm verification, and then manually turn the Page to active.',
      };
    }

    // Subcode 1404082: "You've already posted this. Posting the same content repeatedly..."
    if (errorSubcode === 1404082) {
      return {
        accountStatus: 'active',
        pageStatus: 'active',
        isTransient: false,
        requiresReauth: false,
        message:
          "You've already posted this. Posting the same content repeatedly is not allowed by Facebook.",
      };
    }

    // Subcode 1390008 (or default 368): "We limit how often you can post, comment or do other things..."
    return {
      accountStatus: 'active',
      pageStatus: 'fb_rate_limited',
      isTransient: true,
      requiresReauth: false,
      message:
        'We limit how often you can post, comment or do other things. Page is marked fb_rate_limited and will automatically turn active after 3 days.',
    };
  }

  // API request volume rate limit codes: 4 (app), 17 (user), 32 (page), 341 (app limit), 613 (custom), 80000-80014 (BUC)
  if (
    code === 4 ||
    code === 17 ||
    code === 32 ||
    code === 341 ||
    code === 613 ||
    (code >= 80000 && code <= 80014)
  ) {
    return {
      accountStatus: 'active',
      pageStatus: 'active',
      isTransient: true,
      requiresReauth: false,
      message:
        'Facebook Graph API rate limit reached. Please back off temporarily.',
    };
  }

  return null;
}

export interface TokenExpiryEvaluation {
  isExpired: boolean;
  daysRemaining: number | null;
  status: FacebookAccountStatus;
}

/**
 * Evaluates token expiration horizons relative to current time.
 */
export function evaluateTokenExpiry(
  tokenExpiresAt: Date | string | null | undefined,
  now: Date = new Date()
): TokenExpiryEvaluation {
  if (!tokenExpiresAt) {
    return {
      isExpired: false,
      daysRemaining: null,
      status: 'active',
    };
  }

  const expiresDate = new Date(tokenExpiresAt);
  const diffMs = expiresDate.getTime() - now.getTime();

  if (diffMs <= 0) {
    return {
      isExpired: true,
      daysRemaining: 0,
      status: 'expired',
    };
  }

  const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  return {
    isExpired: false,
    daysRemaining,
    status: 'active',
  };
}

/**
 * Dynamically computes account health status taking token expiration into account.
 */
export function evaluateAccountHealth(
  account: {
    status: FacebookAccountStatus;
    tokenExpiresAt?: Date | string | null;
  },
  now: Date = new Date()
): FacebookAccountStatus {
  if (account.status === 'disconnected') {
    return 'disconnected';
  }

  if (account.tokenExpiresAt) {
    const expiry = evaluateTokenExpiry(account.tokenExpiresAt, now);
    if (expiry.isExpired) {
      return 'expired';
    }
  }

  return account.status;
}

/**
 * Dynamically computes Page health status:
 * - 'paused': user explicitly paused publishing on this Page; remains 'paused' until manually resumed.
 * - 'fb_rate_limited' (Error 368 / Subcode 1390008) automatically turns back to 'active' after 3 days.
 * - 'page_checkpoint' (Error 368 / Subcode 4854002) remains 'page_checkpoint' until manually turned to 'active'.
 */
export function evaluatePageHealth(
  page: {
    status: FacebookPageStatus;
    updatedAt?: Date | string | null;
    rateLimitedAt?: Date | string | null;
  },
  now: Date = new Date()
): FacebookPageStatus {
  if (page.status === 'paused') {
    return 'paused';
  }

  const effectiveTimestamp = page.rateLimitedAt ?? page.updatedAt;
  if (page.status === 'fb_rate_limited' && effectiveTimestamp) {
    const rateLimitedDate = new Date(effectiveTimestamp);
    const elapsedMs = now.getTime() - rateLimitedDate.getTime();
    if (elapsedMs >= FB_RATE_LIMITED_COOLDOWN_MS) {
      return 'active';
    }
  }

  return page.status;
}
