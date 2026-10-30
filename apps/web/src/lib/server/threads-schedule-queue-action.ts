import { NextResponse } from 'next/server';
import {
  lookupIdempotencyResult,
  parseIdempotencyKeyHeader,
  storeIdempotencyResult,
  type IdempotencyScope,
} from '@/lib/publishing/idempotency';
import { logServerError } from '@/lib/server-analytics';
import { isThreadsScheduleAdded, isThreadsSchedulePaused } from '@/lib/server/threads-schedule';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Threads Schedule queue-item actions (publish-now / retry).
 *
 * Deliberately Threads-specific: the Facebook queue publish-now gate
 * is Facebook-only and is not reused. Publish now sets a queued
 * item's scheduled_time to now (the worker claims it on the next
 * pass); retry returns a failed item to queued with scheduled_time
 * now. Both require an active, non-paused schedule destination and
 * an active Threads account — otherwise 409 with a plain reason,
 * never a fake success. Idempotency-Key replays return the original
 * result, like the other queue actions (callers mint one UUID per
 * item action).
 */
export async function handleThreadsQueueItemAction(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
  scheduleId: string,
  itemId: string,
  mode: 'publish-now' | 'retry',
  request: Request
): Promise<NextResponse> {
  const idempotency = parseIdempotencyKeyHeader(request.headers);
  if (idempotency.invalid) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Idempotency-Key must be a UUID' },
      { status: 400 }
    );
  }
  const scope: IdempotencyScope | null = idempotency.key
    ? {
        workspaceId,
        userId,
        action: mode === 'publish-now' ? 'destination-publish-now' : 'destination-retry',
        key: idempotency.key,
      }
    : null;
  if (scope) {
    try {
      const replay = await lookupIdempotencyResult(supabase, scope);
      if (replay) {
        return NextResponse.json(replay.body, {
          status: replay.status,
          headers: { 'Idempotency-Replayed': 'true' },
        });
      }
    } catch (err) {
      logServerError('[threads/schedule] idempotency lookup failed', err, {
        source: 'threads-schedule-queue-action',
      });
      return NextResponse.json({ error: 'Failed to process this request' }, { status: 500 });
    }
  }
  try {
    const { data: destination, error: destError } = await supabase
      .from('destinations')
      .select('id, account_id, status, metadata')
      .eq('id', scheduleId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .maybeSingle();
    if (destError) throw new Error(destError.message);
    if (
      !destination ||
      !isThreadsScheduleAdded(
        (destination as { metadata: Record<string, unknown> | null }).metadata
      )
    ) {
      return NextResponse.json({ error: 'Scheduled account not found' }, { status: 404 });
    }
    const dest = destination as {
      id: string;
      account_id: string;
      status: string;
      metadata: Record<string, unknown> | null;
    };
    if (isThreadsSchedulePaused(dest.metadata) || dest.status !== 'active') {
      return NextResponse.json(
        {
          error: 'NOT_PUBLISHABLE',
          message: isThreadsSchedulePaused(dest.metadata)
            ? 'This account is paused. Resume posting, then try again.'
            : 'This account is not active. Reconnect it in Threads Accounts, then try again.',
        },
        { status: 409 }
      );
    }
    const { data: account, error: accountError } = await supabase
      .from('social_accounts')
      .select('status, token_expires_at')
      .eq('id', dest.account_id)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .maybeSingle();
    if (accountError) throw new Error(accountError.message);
    const accountExpired =
      account?.status === 'expired' ||
      (account?.token_expires_at !== null &&
        account?.token_expires_at !== undefined &&
        Date.parse(account.token_expires_at as string) <= Date.now());
    if (!account || accountExpired) {
      return NextResponse.json(
        {
          error: 'NOT_PUBLISHABLE',
          message: 'This account’s connection has expired. Reconnect it in Threads Accounts, then try again.',
        },
        { status: 409 }
      );
    }
    const { data: item, error: itemError } = await supabase
      .from('queue_items')
      .select('id, status, retry_count')
      .eq('id', itemId)
      .eq('workspace_id', workspaceId)
      .eq('destination_id', scheduleId)
      .maybeSingle();
    if (itemError) throw new Error(itemError.message);
    if (!item) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }
    const expected = mode === 'publish-now' ? 'queued' : 'failed';
    if (item.status !== expected) {
      return NextResponse.json(
        {
          error: 'INVALID_STATUS',
          message:
            mode === 'publish-now'
              ? 'Only queued posts can be published now.'
              : 'Only failed posts can be retried.',
        },
        { status: 409 }
      );
    }
    const { error: updateError } = await supabase
      .from('queue_items')
      .update({
        status: 'queued',
        scheduled_time: new Date().toISOString(),
        claimed_at: null,
        retry_count: mode === 'retry' ? Number(item.retry_count ?? 0) + 1 : item.retry_count,
        updated_at: new Date().toISOString(),
      })
      .eq('id', itemId)
      .eq('workspace_id', workspaceId);
    if (updateError) throw new Error(updateError.message);
    const body = { success: true, id: itemId, status: 'queued' };
    if (scope) {
      // Store failures are logged-and-swallowed inside the helper:
      // the action already succeeded, so failing the response here
      // would cause the exact duplicate retry this exists to prevent.
      await storeIdempotencyResult(supabase, scope, { status: 200, body });
    }
    return NextResponse.json(body);
  } catch (err) {
    logServerError('[threads/schedule] queue action failed', err, {
      source: 'threads-schedule-queue-action',
    });
    return NextResponse.json({ error: 'Failed to process this post' }, { status: 500 });
  }
}
