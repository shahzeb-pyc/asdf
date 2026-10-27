import type { Metadata } from 'next';
import { TermsOfServiceContent } from '@/components/terms/terms-of-service-content';

export const metadata: Metadata = {
  title: 'Terms of Service · FBUploadPro',
  description: 'FBUploadPro terms of service — your account, your content, and how the service works.',
};

/**
 * Public terms page, served at /terms on every host.
 *
 * The middleware passes /terms through publicly (no session, no tenant
 * rewrite), so the same page answers on the app host, the apex host, and
 * every workspace subdomain as https://<workspace>.fbuploadpro.com/terms.
 * It deliberately reads no session and no workspace data.
 */
export default function TermsPage() {
  return <TermsOfServiceContent lastUpdated="27 October 2026" />;
}
