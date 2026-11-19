import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getBrandConfig, getRequestBrandFromHost } from '@/lib/brand';
import { MaintenanceContent } from '@/components/maintenance/maintenance-content';

/**
 * Maintenance page (spec 209).
 *
 * Served at /maintenance on every host. The middleware rewrites
 * every page request here while the maintenance flag is on, and
 * passes /maintenance itself through untouched, so the same page
 * answers on the app host, the apex host, and every workspace
 * subdomain. It deliberately reads no session and no workspace
 * data — the cutover must stop writes from everyone, logged in
 * or not.
 *
 * The brand name follows the request's brand — NextRise Digital
 * on the white-label host, FBUploadPro on ours.
 */
export async function generateMetadata(): Promise<Metadata> {
  const brandConfig = getBrandConfig(getRequestBrandFromHost((await headers()).get('host')));
  return {
    title: `Under maintenance · ${brandConfig.displayName}`,
    description: `${brandConfig.displayName} is under maintenance — we'll be back in an hour.`,
  };
}

export default async function MaintenancePage() {
  const brand = getRequestBrandFromHost((await headers()).get('host'));
  const brandConfig = getBrandConfig(brand);
  return <MaintenanceContent brand={brand} brandName={brandConfig.displayName} />;
}
