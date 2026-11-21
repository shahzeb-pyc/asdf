import { type NextRequest, NextResponse } from 'next/server';
import {
  BulkDeleteBatchRequestSchema,
  BulkDeleteBatchResponseSchema,
} from '@fbuploadpro/contracts';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';
import { logServerError } from '@/lib/server-analytics';
import {
  bulkDeleteErrorResponse,
  resolveBulkDeleteContext,
} from '../route-context';
import {
  bulkDeleteContent,
  resolvePageToken,
} from '@/lib/server/facebook-bulk-delete';

/**
 * POST /api/tenant/[subdomain]/bulk-delete/batch-delete
 *
 * Deletes up to 25 live posts for ONE account AND one page,
 * sequentially, one Graph DELETE per id, and returns per-item
 * results. The page token is resolved server-side via `/me/accounts`
 * (spec 218). Over 25 ids is a 400, never silently truncated.
 * Already-deleted ids report success (`alreadyDeleted`), so a retry
 * after a lost response cannot turn them into new failures.
 * Paid-only, uncapped.
 */
export async function POST(
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

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The request could not be understood. Please try again.' },
      { status: 400 },
    );
  }
  const parsed = BulkDeleteBatchRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'The delete request is invalid. Select at least one post and no more than 25 per batch.',
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
    const result = await bulkDeleteContent(globalThis.fetch, pageToken, parsed.data.contentIds);
    return NextResponse.json(BulkDeleteBatchResponseSchema.parse(result));
  } catch (error) {
    logServerError('[bulk-delete] batch delete failed', error, { source: 'bulk-delete' });
    return bulkDeleteErrorResponse(error);
  }
}
