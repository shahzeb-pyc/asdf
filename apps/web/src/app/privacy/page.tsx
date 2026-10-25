import type { Metadata } from 'next';
import { PrivacyPolicyContent } from '@/components/privacy/privacy-policy-content';

export const metadata: Metadata = {
  title: 'Privacy Policy · FBUploadPro',
  description: 'FBUploadPro privacy policy — what we collect, what we do with it, and your choices.',
};

/**
 * Public privacy page, served at /privacy on every host.
 *
 * The middleware passes /privacy through publicly (no session, no tenant
 * rewrite), so the same page answers on the app host, the apex host, and
 * every workspace subdomain as https://<workspace>.fbuploadpro.com/privacy.
 * It deliberately reads no session and no workspace data.
 */
export default function PrivacyPage() {
  return <PrivacyPolicyContent lastUpdated="25 October 2026" />;
}
