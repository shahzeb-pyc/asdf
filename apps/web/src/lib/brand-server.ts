import { headers } from 'next/headers';
import { resolveBrandFromHost, type Brand } from '@fbuploadpro/contracts';

/**
 * Server-only brand helpers (spec 191).
 *
 * This module imports `next/headers`, so it may ONLY be imported from
 * server code (the root layout). Client components import `@/lib/brand`
 * instead — importing this module from a client component breaks the
 * production build (`next/headers` is server-only).
 */

/** Brand of the current request, from the host header. */
export async function getRequestBrand(): Promise<Brand> {
  // Outside a request scope (tests, static generation) headers()
  // throws — fall back to our brand, the same default the provider uses.
  let host: string | null = null;
  try {
    host = (await headers()).get('host');
  } catch {
    host = null;
  }
  return resolveBrandFromHost(host);
}
