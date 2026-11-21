import { type NextRequest, NextResponse } from 'next/server';
import {
  BulkDeletePreviewRequestSchema,
  BulkDeletePreviewResponseSchema,
} from '@fbuploadpro/contracts';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';
import { logServerError } from '@/lib/server-analytics';
import {
  bulkDeleteErrorResponse,
  resolveBulkDeleteContext,
} from '../route-context';
import {
  resolveDeleteCandidates,
  resolvePageToken,
} from '@/lib/server/facebook-bulk-delete';

/**
 * POST /api/tenant/[subdomain]/bulk-delete/preview
 *
 * Smart Filter preview: up to 500 live-post candidates for ONE page.
 * The client fans out across selected pages (sequentially) and merges.
 * Paid-only, uncapped. The page token is resolved server-side via
 * `/me/accounts` (spec 218); the request schema is strict — a token
 * field is a 400.
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
  const parsed = BulkDeletePreviewRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'The preview request is invalid. Check the selected page, type, sort and dates.',
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
    const result = await resolveDeleteCandidates(globalThis.fetch, pageToken, {
      pageId: parsed.data.pageId,
      type: parsed.data.type,
      sort: parsed.data.sort,
      ...(parsed.data.dateFrom ? { dateFrom: parsed.data.dateFrom } : {}),
      ...(parsed.data.dateTo ? { dateTo: parsed.data.dateTo } : {}),
    });
    return NextResponse.json(BulkDeletePreviewResponseSchema.parse(result));
  } catch (error) {
    logServerError('[bulk-delete] preview failed', error, { source: 'bulk-delete' });
    return bulkDeleteErrorResponse(error);
  }
}
