import { type NextRequest, NextResponse } from 'next/server';
import {
  BulkDeleteContentRequestSchema,
  BulkDeleteContentResponseSchema,
} from '@fbuploadpro/contracts';
import { enforceIpRateLimit } from '@/lib/request-body';
import { logServerError } from '@/lib/server-analytics';
import {
  bulkDeleteErrorResponse,
  resolveBulkDeleteContext,
} from '../route-context';
import {
  listPageContent,
  resolvePageToken,
} from '@/lib/server/facebook-bulk-delete';

/**
 * GET /api/tenant/[subdomain]/bulk-delete/content
 *
 * Manual Curation list: live page content for ONE page, cursor-paged.
 * Query: accountId, pageId, type (posts|photos|reels), limit (1–100,
 * default 25), after (cursor). Paid-only, uncapped.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> },
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_bulk_delete', 60, {
    scope: `ws:${subdomain}`,
  });
  if (limited) return limited;

  const resolved = await resolveBulkDeleteContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved;

  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  const parsed = BulkDeleteContentRequestSchema.safeParse(query);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'The content request is invalid. Check the selected page and type.',
        details: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  try {
    const pageToken = await resolvePageToken(
      globalThis.fetch,
      supabase,
      workspaceId,
      parsed.data.accountId,
      parsed.data.pageId,
    );
    const result = await listPageContent(globalThis.fetch, pageToken, {
      pageId: parsed.data.pageId,
      type: parsed.data.type,
      limit: parsed.data.limit,
      ...(parsed.data.after ? { after: parsed.data.after } : {}),
    });
    return NextResponse.json(BulkDeleteContentResponseSchema.parse(result));
  } catch (error) {
    logServerError('[bulk-delete] content failed', error, { source: 'bulk-delete' });
    return bulkDeleteErrorResponse(error);
  }
}
