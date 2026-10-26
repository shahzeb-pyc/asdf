/**
 * Destinations pages were removed: the dedicated Pages section is the only
 * home for a Facebook Page, and there is no longer a separate
 * destination view. This route survives ONLY as a redirector so previously
 * reachable links never land on a bare 404:
 * - a destination that maps to a Facebook Page (its external id matches a
 *   page's Facebook page id) redirects to that page's dedicated view;
 * - anything else (unknown destination, non-Facebook destination, any
 *   lookup failure) redirects to the Pages list.
 * The destination data model, its APIs, queue links, slots, and the shared
 * composer are untouched — only the user-facing destination views went.
 */
import { redirect } from 'next/navigation';

import { buildTenantApiPath } from '@/lib/api/client';
import { DestinationDetailResponseSchema } from '@/lib/api/schemas/connect';
import { ListFacebookPagesResponseSchema } from '@/lib/api/schemas/pages';
import { serverApiFetch } from '@/lib/data/server';

interface DestinationRedirectPageProps {
  params: Promise<{ subdomain: string; destinationId: string }>;
}

export default async function DestinationRedirectPage({
  params,
}: Readonly<DestinationRedirectPageProps>) {
  const { subdomain, destinationId } = await params;
  const pagesList = `/tenant/${subdomain}/pages`;
  let target = pagesList;
  try {
    const detail = await serverApiFetch(
      buildTenantApiPath(subdomain, `/accounts/social/${destinationId}`),
      { schema: DestinationDetailResponseSchema }
    );
    if (detail.destination.platform === 'facebook') {
      const pages = await serverApiFetch(
        buildTenantApiPath(subdomain, '/pages'),
        { schema: ListFacebookPagesResponseSchema }
      );
      const page = pages.pages.find(
        (candidate) => candidate.fbPageId === detail.destination.externalDestinationId
      );
      if (page) {
        target = `/tenant/${subdomain}/pages/${page.id}`;
      }
    }
  } catch {
    // Any lookup failure falls through to the Pages list — never a 404
    // and never an error page for a previously reachable link.
    target = pagesList;
  }
  redirect(target);
}
