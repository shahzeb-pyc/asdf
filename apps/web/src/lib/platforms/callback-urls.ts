/**
 * @file callback-urls.ts
 * @description Single source for the public addresses each platform asks
 * for during setup. The settings tabs render these addresses for the user
 * to copy into the platform's own settings, and the connect flows for each
 * platform use the same paths, so the shown address can never drift from
 * the real one.
 *
 * Exception: Facebook and Instagram settings views do NOT use this
 * helper for their sign-in address — their flows use direct callbacks
 * (`/api/auth/facebook/callback`, `/api/auth/instagram/callback`), so
 * those views build the shown address with the direct-flow builder
 * instead. Threads is the remaining settings consumer of
 * `signInCallback` here.
 *
 * The origin is resolved exactly the way the Facebook settings view
 * resolves the origin for the sign-in address it displays: the current
 * window origin when running in the browser, with the production site as
 * the fallback.
 */

export type CallbackPlatform = 'facebook' | 'instagram' | 'threads' | 'youtube' | 'x' | 'tiktok';

export type CallbackKind = 'signIn' | 'deauthorize' | 'dataDeletion';

export interface PlatformCallbackUrls {
  signInCallback: string;
  deauthorizeCallback: string;
  dataDeletionCallback: string;
}

const CALLBACK_PATHS: Record<CallbackKind, (platform: string) => string> = {
  signIn: (platform) => `/api/connect/${platform}/callback`,
  deauthorize: (platform) => `/api/connect/${platform}/deauthorize`,
  dataDeletion: (platform) => `/api/connect/${platform}/data-deletion`,
};

/** Resolve the display origin the same way the Facebook settings view does. */
export function resolveCallbackOrigin(): string {
  return typeof window !== 'undefined' && window.location.origin
    ? window.location.origin
    : 'https://fbuploadpro.com';
}

/** Build one callback address for a platform. */
export function getPlatformCallbackUrl(
  platform: CallbackPlatform,
  kind: CallbackKind,
  origin: string = resolveCallbackOrigin()
): string {
  let base = origin;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}${CALLBACK_PATHS[kind](platform)}`;
}

/** Build all three callback addresses a platform's settings may ask for. */
export function getPlatformCallbackUrls(
  platform: CallbackPlatform,
  origin: string = resolveCallbackOrigin()
): PlatformCallbackUrls {
  return {
    signInCallback: getPlatformCallbackUrl(platform, 'signIn', origin),
    deauthorizeCallback: getPlatformCallbackUrl(platform, 'deauthorize', origin),
    dataDeletionCallback: getPlatformCallbackUrl(platform, 'dataDeletion', origin),
  };
}
