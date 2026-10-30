/**
 * Instagram OAuth-return notice resolver — Facebook's
 * `resolveOAuthRedirectNotice` from `accounts-helpers.ts`, with Instagram
 * copy. Same keys, same shapes: `connected=1`, `connected=already`,
 * `reconnected_mismatch=1`, and `error` (including
 * `credentials_required`, pointing at the Instagram App credentials).
 *
 * Note: this parser is currently dormant for the generic framework
 * connect flow, because the framework's complete step navigates to
 * `/tenant/<subdomain>/accounts` (Facebook Accounts) for every platform
 * — a shared file outside this build's ownership, deliberately not
 * changed here. It is implemented so the IG page handles any return
 * that does land here with exactly Facebook's notice semantics.
 */
export function resolveInstagramOAuthRedirectNotice(searchParams: {
  get: (key: string) => string | null;
}): {
  notice: { type: 'success' | 'error'; message: string };
  /** Account name carried by the redirect, when present — used to highlight its card. */
  accountName?: string | undefined;
  keysToRemove: string[];
} | null {
  const reconnectedMismatch = searchParams.get('reconnected_mismatch');
  if (reconnectedMismatch === '1') {
    const newAccountName = searchParams.get('newAccountName') || 'another account';
    const expectedAccountName = searchParams.get('expectedAccountName') || 'the expired account';
    return {
      notice: {
        type: 'error',
        message: `You signed into ${newAccountName} instead of ${expectedAccountName}. ${expectedAccountName} still needs to be reconnected.`,
      },
      keysToRemove: ['reconnected_mismatch', 'newAccountName', 'expectedAccountName'],
    };
  }

  const connected = searchParams.get('connected');
  if (connected === 'already') {
    const accountName = searchParams.get('accountName') || 'Account';
    return {
      notice: {
        type: 'success',
        message: `${accountName} already connected — session refreshed`,
      },
      accountName,
      keysToRemove: ['connected', 'accountName'],
    };
  }

  if (connected === '1') {
    const accountName = searchParams.get('accountName') || undefined;
    return {
      notice: {
        type: 'success',
        message: accountName ? `${accountName} connected` : 'Instagram account connected',
      },
      accountName,
      keysToRemove: ['connected', 'accountName'],
    };
  }

  const error = searchParams.get('error');
  if (error) {
    if (error === 'credentials_required') {
      return {
        notice: {
          type: 'error',
          message:
            'Instagram App credentials are required before connecting accounts. Please configure your App ID and Secret in Workspace Settings.',
        },
        keysToRemove: ['error', 'tab'],
      };
    }
    const isCancelled = error === 'access_denied' || error === 'user_cancelled';
    const message = isCancelled
      ? 'Connection canceled. No changes were made.'
      : "Couldn't connect to Instagram. Check your permissions and try again.";
    return {
      notice: {
        type: 'error',
        message,
      },
      keysToRemove: ['error'],
    };
  }

  return null;
}
