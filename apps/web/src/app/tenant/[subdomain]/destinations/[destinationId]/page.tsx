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

import { buildTenantApiPath, buildUrl } from '@/lib/api/client';
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
      // The pages list is paginated (30/page, max 50), so a single
      // unparameterised fetch only sees page 1 — a destination mapping
      // to a page beyond page 1 would miss and wrongly fall back to
      // the list. Walk pages at max size until the match is found or
      // the list runs out. Old-link hits are rare and server-side, so
      // the extra fetches cost nothing in the browser; the 200-page
      // guard (10,000 pages) bounds the walk even if a payload ever
      // omits totalPages.
      const wantedFbPageId = detail.destination.externalDestinationId;
      for (let page = 1, guard = 0; guard < 200; page += 1, guard += 1) {
        const res = await serverApiFetch(
          buildUrl(buildTenantApiPath(subdomain, '/pages'), { page, limit: 50 }),
          { schema: ListFacebookPagesResponseSchema }
        );
        const match = res.pages.find(
          (candidate) => candidate.fbPageId === wantedFbPageId
        );
        if (match) {
          target = `/tenant/${subdomain}/pages/${match.id}`;
          break;
        }
        if (res.totalPages !== undefined && res.totalPages > 0) {
          if (page >= res.totalPages) break;
        } else if (res.pages.length < 50) {
          // Pre-pagination payload shape (no totalPages): a short page
          // is the last page.
          break;
        }
      }
    }
  } catch {
    // Any lookup failure falls through to the Pages list — never a 404
    // and never an error page for a previously reachable link.
    target = pagesList;
  }
  redirect(target);
}
