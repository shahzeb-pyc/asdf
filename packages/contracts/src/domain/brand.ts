import { z } from 'zod';

/**
 * White-label brand (spec 191 — NextRise Digital).
 *
 * The brand is a first-class fact: it lives on the user record, in the
 * session token, and is resolved from the request host at every entry
 * point. Our brand is the fail-safe default — an unknown host or a
 * missing brand renders fbuploadpro, never NextRise.
 */

/** The two brands the app can serve. */
export const BrandSchema = z.enum(['fbuploadpro', 'nextrise']);
export type Brand = z.infer<typeof BrandSchema>;

/** Gateway host of the white-label brand. */
export const NEXTRISE_APP_HOST = 'app.sajidaliai.online';
/** Tenant-host suffix of the white-label brand: `<workspace>.app.sajidaliai.online`. */
export const NEXTRISE_TENANT_ROOT = 'app.sajidaliai.online';
/** Support number shown on the white-label brand. */
export const NEXTRISE_WHATSAPP_NUMBER = '0308-1311411';
/** The same number in international form, for the wa.me link. */
export const NEXTRISE_WHATSAPP_INTERNATIONAL = '923081311411';
/** Display name of the white-label brand. */
export const NEXTRISE_DISPLAY_NAME = 'NextRise Digital';
/** Short name used in the sidebar wordmark and aria labels. */
export const NEXTRISE_SHORT_NAME = 'NextRise';
/** Public asset path of the white-label logo (SVG, copied from the white-label site's icon). */
export const NEXTRISE_LOGO_PATH = '/brand/nextrise-logo.svg';

/**
 * Resolve the brand from a request host. Case-insensitive, port-insensitive.
 * The bare white-label domain (sajidaliai.online) is NOT an app host — it
 * resolves to our brand, so nothing white-label ever leaks onto it.
 */
export function resolveBrandFromHost(host: string | null | undefined): Brand {
  if (!host) return 'fbuploadpro';
  const clean = host.trim().toLowerCase().split(':')[0] ?? '';
  if (clean === NEXTRISE_APP_HOST) return 'nextrise';
  if (clean.endsWith(`.${NEXTRISE_APP_HOST}`)) return 'nextrise';
  return 'fbuploadpro';
}

/**
 * Tenant-host suffix for a brand. Our brand uses the configured root
 * (from `NEXT_PUBLIC_ROOT_DOMAIN`); the white-label brand always uses
 * `app.sajidaliai.online`, whatever the deployment's root is.
 *
 * Verbatim: the port is part of the root (`localhost:3000`), and an
 * empty root stays empty — the routing helpers resolve locally from
 * the request URL when no root is configured. An earlier version
 * stripped the port and defaulted empty to `fbuploadpro.com`, which
 * broke localhost login redirects (`:3000` lost) and the OAuth
 * local-resolution fallback (a configured-looking root where none
 * was set). Callers that need a bare hostname (cookie domains) strip
 * the port themselves before calling.
 */
export function getBrandTenantRoot(brand: Brand, fallbackRoot: string): string {
  if (brand === 'nextrise') return NEXTRISE_TENANT_ROOT;
  return fallbackRoot.trim().toLowerCase();
}

/**
 * Gateway host (the app's front door) for a brand. Our brand keeps the
 * historic `app.<root>` form exactly, port included; the white-label
 * brand is always `app.sajidaliai.online`.
 */
export function getBrandGatewayHost(brand: Brand, fallbackRoot: string): string {
  if (brand === 'nextrise') return NEXTRISE_APP_HOST;
  const clean = (fallbackRoot || 'fbuploadpro.com').trim().toLowerCase();
  return `app.${clean}`;
}

/** Feature flags that differ by brand. Pure — no env, no request. */
export const BrandFlagsSchema = z.object({
  /** Registration form and signup API exist on the brand. */
  allowSignup: z.boolean(),
  /** Billing section (menu, pages, routes, APIs) exists on the brand. */
  showBilling: z.boolean(),
  /** Forgot-password / reset-password exist on the brand. */
  allowPasswordReset: z.boolean(),
  /** Muse section and guide exist on the brand. */
  showMuse: z.boolean(),
  /** Topbar plan-days pill renders on the brand. */
  showTopbarDaysPill: z.boolean(),
});
export type BrandFlags = z.infer<typeof BrandFlagsSchema>;

export function getBrandFlags(brand: Brand): BrandFlags {
  if (brand === 'nextrise') {
    return {
      allowSignup: false,
      showBilling: false,
      allowPasswordReset: false,
      // Owner reversal 2026-11-15: NextRise students CAN use Muse.
      showMuse: true,
      showTopbarDaysPill: true,
    };
  }
  return {
    allowSignup: true,
    showBilling: true,
    allowPasswordReset: true,
    showMuse: true,
    showTopbarDaysPill: false,
  };
}

/** The white-label brand's full display configuration. */
export const BrandConfigSchema = z.object({
  brand: BrandSchema,
  displayName: z.string().min(1),
  shortName: z.string().min(1),
  /** Public asset path of the brand logo, or null when the inline mark is used. */
  logoPath: z.string().nullable(),
  /** WhatsApp support number as a wa.me dial string: international form, no trunk 0. */
  whatsappNumber: z.string().min(1),
  whatsappMessage: z.string().min(1),
  ...BrandFlagsSchema.shape,
});
export type BrandConfig = z.infer<typeof BrandConfigSchema>;

export const NEXTRISE_BRAND_CONFIG: BrandConfig = {
  brand: 'nextrise',
  displayName: NEXTRISE_DISPLAY_NAME,
  shortName: NEXTRISE_SHORT_NAME,
  logoPath: NEXTRISE_LOGO_PATH,
  // wa.me needs the international form (923081311411), not the display
  // form 0308-1311411 — the trunk 0 is not diallable via wa.me.
  whatsappNumber: NEXTRISE_WHATSAPP_INTERNATIONAL,
  whatsappMessage: 'Hi! I need assistance with my NextRise account.',
  ...getBrandFlags('nextrise'),
};

/**
 * Plain en-GB rejection for a cross-brand login: the account exists on
 * the other brand. The message names where to go, never why internally.
 */
export function brandLoginMismatchMessage(accountBrand: Brand): string {
  if (accountBrand === 'nextrise') {
    return `This account belongs to NextRise. Please log in at ${NEXTRISE_APP_HOST}.`;
  }
  return 'This account belongs to FBUploadPro. Please log in at app.fbuploadpro.com.';
}

/** Registration / password-reset entry paths, blocked on the white-label brand. */
const BLOCKED_AUTH_PATHS = new Set([
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-otp',
]);

/** First path segment of the tenant pages hidden on the white-label brand. */
const BLOCKED_TENANT_SEGMENTS = new Set([
  'billing',
  'my-plan',
  'purchase',
  'payments',
  'refund',
]);

/** Remove the leading `/tenant/<subdomain>` prefix from a tenant-form path, if present. */
export function stripTenantPathPrefix(pathname: string): string {
  const match = pathname.match(/^\/tenant\/[^/]+(\/.*)?$/);
  if (!match) return pathname;
  return match[1] ?? '/';
}

/** Tenant page (bare or `/tenant/<subdomain>/…` form) hidden on the white-label brand. */
export function isWhiteLabelBlockedTenantPath(brand: Brand, pathname: string): boolean {
  if (brand !== 'nextrise') return false;
  const rest = stripTenantPathPrefix(pathname);
  const first = rest.split('/').filter(Boolean)[0] ?? '';
  return BLOCKED_TENANT_SEGMENTS.has(first.toLowerCase());
}

/** Entry/auth path hidden on the white-label brand. */
export function isWhiteLabelBlockedAuthPath(brand: Brand, pathname: string): boolean {
  if (brand !== 'nextrise') return false;
  return BLOCKED_AUTH_PATHS.has(pathname.toLowerCase());
}

/** API route hidden on the white-label brand. */
export function isWhiteLabelBlockedApiPath(brand: Brand, pathname: string): boolean {
  if (brand !== 'nextrise') return false;
  const lower = pathname.toLowerCase();
  if (lower === '/api/auth/signup' || lower.startsWith('/api/auth/signup/')) return true;
  if (lower === '/api/auth/forgot-password' || lower.startsWith('/api/auth/forgot-password/')) {
    return true;
  }
  if (lower === '/api/auth/reset-password' || lower.startsWith('/api/auth/reset-password/')) {
    return true;
  }
  if (/^\/api\/tenant\/[^/]+\/billing(\/.*)?$/.test(lower)) return true;
  // Owner reversal 2026-11-15: the Muse API is NOT blocked on the
  // white-label brand — NextRise students use Muse, keys included.
  // Billing stays blocked above; signup / password reset above too.
  return false;
}
