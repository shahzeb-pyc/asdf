'use client';

import React from 'react';
import { NEXTRISE_BRAND_CONFIG, type Brand, type BrandConfig } from '@fbuploadpro/contracts';
import { getBrandConfig } from '@/lib/brand';

/**
 * Brand context (spec 191). The root layout resolves the brand from the
 * request host (server) and provides it; client components read it with
 * `useBrand()`. The default is our brand, so components rendered outside
 * a provider — tests included — keep today's behaviour.
 */
const BrandContext = React.createContext<Brand>('fbuploadpro');

export function BrandProvider({
  brand,
  children,
}: {
  brand: Brand;
  children: React.ReactNode;
}) {
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
}

export function useBrand(): Brand {
  return React.useContext(BrandContext);
}

/** Full display configuration of the current brand. */
export function useBrandConfig(): BrandConfig {
  const brand = React.useContext(BrandContext);
  if (brand === 'nextrise') return NEXTRISE_BRAND_CONFIG;
  return getBrandConfig('fbuploadpro');
}
