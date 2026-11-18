import {
  NEXTRISE_BRAND_CONFIG,
  getBrandFlags,
  getBrandGatewayHost,
  getBrandTenantRoot,
  resolveBrandFromHost,
  type Brand,
  type BrandConfig,
  type BrandFlags,
} from '@fbuploadpro/contracts';
import { buildWhatsAppSupportUrl, DEFAULT_WHATSAPP_SUPPORT_MESSAGE } from './whatsapp';

/**
 * Brand resolution for the web app (spec 191).
 *
 * The brand comes from the request host, never from a cookie, a query
 * string, or user input. Our brand is the fail-safe default.
 *
 * This module is safe to import from client components: it never
 * imports `next/headers` (that lives in `lib/brand-server.ts`, used
 * only by the root layout's server code — importing it here would
 * break the production build, because `next/headers` is server-only).
 */

export function getConfiguredRootDomain(): string {
  return process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000';
}

/** Brand of a request-like object (middleware / route handlers). */
export function getRequestBrandFromHost(host: string | null | undefined): Brand {
  return resolveBrandFromHost(host);
}

/** Tenant-host suffix for a brand, from the configured root. */
export function getRequestBrandTenantRoot(brand: Brand): string {
  return getBrandTenantRoot(brand, getConfiguredRootDomain());
}

/** Gateway host (the app's front door) for a brand. */
export function getRequestBrandGatewayHost(brand: Brand): string {
  return getBrandGatewayHost(brand, getConfiguredRootDomain());
}

export function getBrandFlagsFor(brand: Brand): BrandFlags {
  return getBrandFlags(brand);
}

/**
 * Full display configuration for a brand. Our brand's WhatsApp number
 * still comes from the environment (as before); the white-label brand
 * uses its published number.
 */
export function getBrandConfig(brand: Brand): BrandConfig {
  if (brand === 'nextrise') {
    return NEXTRISE_BRAND_CONFIG;
  }
  return {
    brand: 'fbuploadpro',
    displayName: 'FBUploadPro',
    shortName: 'FBUploadPro',
    logoPath: null,
    whatsappNumber: process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER ?? '',
    whatsappMessage: DEFAULT_WHATSAPP_SUPPORT_MESSAGE,
    ...getBrandFlags('fbuploadpro'),
  };
}

/**
 * Effective tenant root for a request (spec 191) — the root the OAuth
 * callbacks and connect routes must build their redirect URIs under.
 * NextRise requests always resolve under sajidaliai.online (workspaces
 * `<workspace>.sajidaliai.online`, app host app.sajidaliai.online); our brand
 * keeps the configured root verbatim. The fallback preserves each
 * caller's old env-unset default ('' for the OAuth routes — the
 * routing helpers resolve locally from the request URL then — and
 * 'localhost:3000' for logout).
 */
export function getRequestBrandRoot(
  request: { headers: { get(name: string): string | null } } | undefined | null,
  fallback = '',
): string {
  const configured = process.env.NEXT_PUBLIC_ROOT_DOMAIN || fallback;
  return getBrandTenantRoot(getRequestBrandFromHost(request?.headers.get('host') ?? null), configured);
}

/** WhatsApp support URL for a brand (number + message both brand-aware). */
export function buildBrandWhatsAppSupportUrl(brand: Brand): string | null {
  const config = getBrandConfig(brand);
  return buildWhatsAppSupportUrl({ phone: config.whatsappNumber, message: config.whatsappMessage });
}
