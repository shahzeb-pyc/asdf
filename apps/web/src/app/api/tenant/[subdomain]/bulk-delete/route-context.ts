import { type NextRequest, NextResponse } from 'next/server';
import { SubscriptionGateError } from '@/lib/billing/entitlement';
import { assertPaidPlan } from '@/lib/billing/entitlement';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { resolveSocialRouteContext } from '@/lib/connect/session';
import { BulkDeleteError } from '@/lib/server/facebook-bulk-delete';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@fbuploadpro/contracts';

/**
 * Shared prelude for the bulk-delete routes (spec 213): session +
 * tenant context, then the Paid-only gate. The gate is plan-only and
 * uncapped — no usage rows, no cap counting. Admins are not gated
 * (same as Publish Now). A gate failure fails the whole request;
 * an entitlement-read failure fails closed, never a free pass.
 */
export async function resolveBulkDeleteContext(
  request: NextRequest,
  subdomain: string,
): Promise<
  | { session: { userId: string; role?: string }; workspaceId: string; supabase: SupabaseClient<Database> }
  | { errorResponse: NextResponse }
> {
  const routeContext = await resolveSocialRouteContext(request, subdomain);
  if (routeContext.errorResponse) return { errorResponse: routeContext.errorResponse };
  const { session, workspaceId } = routeContext;
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Something went wrong. Please try again.' },
        { status: 503 },
      ),
    };
  }
  if (session.role !== 'admin') {
    try {
      await assertPaidPlan(supabase, session.userId);
    } catch (err) {
      if (err instanceof SubscriptionGateError) {
        const status = err.code === 'SUBSCRIPTION_REQUIRED' ? 403 : 500;
        return {
          errorResponse: NextResponse.json(
            { error: err.code, message: err.message },
            { status },
          ),
        };
      }
      throw err;
    }
  }
  return { session, workspaceId, supabase };
}

/** Map a service error to a plain-language response. Never leaks Graph internals. */
export function bulkDeleteErrorResponse(error: unknown): NextResponse {
  if (error instanceof BulkDeleteError) {
    switch (error.code) {
      case 'ACCOUNT_NOT_FOUND':
        return NextResponse.json({ error: error.message }, { status: 404 });
      case 'TOKEN_DEAD':
        return NextResponse.json({ error: error.message }, { status: 409 });
      default:
        return NextResponse.json(
          { error: 'Something went wrong. Please try again.' },
          { status: 500 },
        );
    }
  }
  return NextResponse.json(
    { error: 'Something went wrong. Please try again.' },
    { status: 500 },
  );
}
