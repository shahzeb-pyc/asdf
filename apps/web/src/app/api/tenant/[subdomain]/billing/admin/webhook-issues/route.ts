import { type NextRequest, NextResponse } from 'next/server';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { readJsonBody } from '@/lib/request-body';
import {
  dismissWebhookIssue,
  listOpenWebhookIssues,
} from '@/lib/billing/webhook-issues';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';

/**
 * GET /api/tenant/[subdomain]/billing/admin/webhook-issues
 * Admin only: open NOWPayments webhook issues (unknown payments,
 * amount/currency mismatches, underpayments, late-finish coupon
 * releases, gateway refunds) newest first. An empty list when the
 * issues table is absent (migration unapplied) — display-only, so
 * a missing table must not fail the admin view.
 *
 * POST with { issueId }: dismiss one issue (it stays in the table
 * with dismissed_at set; dismissed rows never list again).
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }
  const issues = await listOpenWebhookIssues(client);
  return NextResponse.json({
    issues: issues.map((issue) => ({
      id: issue.id,
      provider: issue.provider,
      providerPaymentId: issue.providerPaymentId,
      paymentId: issue.paymentId,
      reason: issue.reason,
      detail: issue.detail,
      dismissedAt: issue.dismissedAt,
      createdAt: issue.createdAt,
    })),
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The request could not be read.' },
      { status: 400 }
    );
  }
  const value = bodyResult.value as Record<string, unknown>;
  const issueId = typeof value['issueId'] === 'string' ? value['issueId'] : null;
  if (!issueId) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Choose an issue to dismiss.' },
      { status: 400 }
    );
  }
  const dismissed = await dismissWebhookIssue(client, issueId);
  if (!dismissed) {
    return NextResponse.json(
      { error: 'NOT_FOUND', message: 'That issue could not be found.' },
      { status: 404 }
    );
  }
  return NextResponse.json({ dismissed: true });
}
