import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { PrivacyPolicyContent } from '@/components/privacy/privacy-policy-content';
import { getBrandConfig, getRequestBrandFromHost } from '@/lib/brand';

/**
 * Public privacy page, served at /privacy on every host.
 *
 * The middleware passes /privacy through publicly (no session, no tenant
 * rewrite), so the same page answers on the app host, the apex host, and
 * every workspace subdomain as https://<workspace>.fbuploadpro.com/privacy.
 * It deliberately reads no session and no workspace data.
 *
 * Spec 191: the brand name in the metadata and copy follows the
 * request's brand — NextRise Digital on the white-label host.
 */
export async function generateMetadata(): Promise<Metadata> {
  const brandConfig = getBrandConfig(getRequestBrandFromHost((await headers()).get('host')));
  return {
    title: `Privacy Policy · ${brandConfig.displayName}`,
    description: `${brandConfig.displayName} privacy policy — what we collect, what we do with it, and your choices.`,
  };
}

export default async function PrivacyPage() {
  const brandConfig = getBrandConfig(getRequestBrandFromHost((await headers()).get('host')));
  return (
    <PrivacyPolicyContent lastUpdated="25 October 2026" brandName={brandConfig.displayName} />
  );
}
