import { type NextRequest, NextResponse } from 'next/server';
import {
  AduBulkCreateSchema,
  AduCreateConfigSchema,
  generateDailyRandomTimes,
  resolveAduBulkItemSchedule,
  sanitizeSourceIdentity,
  validateAduBulkFixedTimes,
  type AduSourcePlatform,
} from '@fbuploadpro/contracts';
import {
  loadThreadsAduConfigView,
  threadsAduContext,
  threadsAduMissingTable,
} from '@/lib/server/threads-adu';
import { aduDestinationKeysForCap, type AduConfigView } from '@/lib/server/adu';
import { assertFeatureAddWithinCap } from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  subscriptionGateResponse,
} from '@/lib/billing/route-helpers';

function statusFilterToValue(filter: string): string | null {
  const map: Record<string, string> = {
    Active: 'active',
    Inactive: 'inactive',
    'Verification Req.': 'fb_verification_required',
    'Rate Limited': 'fb_rate_limited',
    'Page Not Accessible': 'page_not_accessible',
    'Invalid Token': 'invalid_token',
    'Invalid Username': 'invalid_username',
    'Creator Suspended': 'creator_suspended',
    Completed: 'completed',
    '2FA Req. on BM': '2fa_required_on_BM',
    'Check Dev App': 'check_developer_app',
    'Account Suspended': 'account_suspended',
  };
  return map[filter] ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  // Search/status/sort/page are applied in the database by the
  // threads_adu_hub_list / threads_adu_hub_stats RPCs (20261030140000): the old code
  // loaded every config for the workspace and sliced 9/page in memory,
  // which silently truncated past PostgREST's 1,000-row limit. Only
  // the 9 rows of the requested page are ever built into views, and
  // totals/stats come from the database, not from a sliced array.
  const search = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  const statusFilter = request.nextUrl.searchParams.get('status') ?? 'All Statuses';
  const sort = request.nextUrl.searchParams.get('sort') ?? 'Newest First';
  const page = Math.max(1, Number(request.nextUrl.searchParams.get('page') ?? '1') || 1);
  const pageSize = 9;
  const statusValue = statusFilterToValue(statusFilter);
  const { data: rows, error } = await supabase.rpc('threads_adu_hub_list', {
    p_workspace_id: workspaceId,
    p_search: search || null,
    p_status: statusValue,
    p_sort: sort,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (error) {
    // 42P01 = ADU tables missing; 42883 = the RPC itself missing, which
    // also means the ADU migrations have not been applied yet.
    if (threadsAduMissingTable(error) || error.code === '42883') {
      return NextResponse.json({ configs: [], total: 0, page: 1, migrationMissing: true });
    }
    console.error(`ADU hub list failed: code=${error.code ?? 'unknown'}`);
    return NextResponse.json({ error: 'Failed to load accounts.' }, { status: 500 });
  }
  const listRows = (rows ?? []) as Array<Record<string, unknown> & { total_count?: number }>;
  const total = listRows[0]?.total_count ?? 0;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const views: AduConfigView[] = [];
  for (const row of listRows) {
    views.push((await loadThreadsAduConfigView(supabase, workspaceId, (row as { id: string }).id))!);
  }
  const { data: statsRows, error: statsError } = await supabase.rpc('threads_adu_hub_stats', {
    p_workspace_id: workspaceId,
    p_search: search || null,
    p_status: statusValue,
  });
  if (statsError) {
    console.error(`ADU hub stats failed: code=${statsError.code ?? 'unknown'}`);
  }
  // RPC names match the old in-memory stats exactly: totalFollowers
  // is the sum of followers_gained, followersGained is the sum of the
  // net growth (followers_gained minus followers_count, floored at 0).
  const statsRow = (statsRows as Array<{
    total_count?: number;
    total_followers_sum?: number;
    net_gained_sum?: number;
  }> | null)?.[0];
  return NextResponse.json({
    configs: views,
    total,
    page,
    totalPages,
    stats: {
      totalPages: total,
      followersGained: statsRow?.net_gained_sum ?? 0,
      totalFollowers: statsRow?.total_followers_sum ?? 0,
    },
  });
}

import type { SupabaseClient } from '@supabase/supabase-js';

interface AduRouteContext {
  workspaceId: string;
  supabase: SupabaseClient;
}

async function createOne(
  ctx: AduRouteContext,
  input: {
    destinationId: string;
    sourcePlatform: AduSourcePlatform;
    sourceUsername: string;
    timezone: string;
    postsPerDay: number;
    scheduleType: 'dailyrandom' | 'fixed';
    postingTimes?: string[] | undefined;
  }
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { workspaceId, supabase } = ctx;
  const username = sanitizeSourceIdentity(input.sourcePlatform, input.sourceUsername);
  if (!username) return { ok: false, error: 'Enter a source username.' };
  const { data: destination, error: destError } = await supabase
    .from('destinations')
    .select('id, avatar_url, metadata')
    .eq('workspace_id', workspaceId)
    .eq('id', input.destinationId)
    .eq('platform', 'threads')
    .maybeSingle();
  if (destError || !destination) {
    return { ok: false, error: 'That Threads account was not found in this workspace.' };
  }
  const postingTimes =
    input.scheduleType === 'fixed'
      ? (input.postingTimes ?? [])
      : generateDailyRandomTimes(input.postsPerDay);
  const metadata = (destination.metadata ?? {}) as Record<string, unknown>;
  const startingFollowers =
    typeof metadata.current_followers === 'number' ? metadata.current_followers : 0;
  const { data, error } = await supabase
    .from('adu_configs')
    .insert({
      workspace_id: workspaceId,
      destination_id: input.destinationId,
      source_platform: input.sourcePlatform,
      source_username: username,
      timezone: input.timezone,
      posts_per_day: input.postsPerDay,
      schedule_type: input.scheduleType,
      posting_times: postingTimes,
      status: 'active',
      sync_status: 'pending',
      followers_count: startingFollowers,
      followers_gained: startingFollowers,
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') {
      return { ok: false, error: 'This account or source user is already configured.' };
    }
    if (threadsAduMissingTable(error)) {
      return {
        ok: false,
        error: 'The ADU tables have not been created yet. Apply migration 20261030120000_adu.sql, then try again.',
      };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true, id: data.id as string };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  // Bulk: { items: [...], timezone, postsPerDay, scheduleType, postingTimes? }
  if (Array.isArray((body as { items?: unknown }).items)) {
    const parsed = AduBulkCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid bulk request.' },
        { status: 400 }
      );
    }
    // Fixed-times validation lives in contracts (shared + per-item
    // 'separate' schedules, old wording), so the route and the tests
    // cannot drift apart.
    const fixedError = validateAduBulkFixedTimes(parsed.data);
    if (fixedError) {
      return NextResponse.json({ error: fixedError }, { status: 400 });
    }
    // Plan cap gate: adding ADU configs registers the target
    // accounts against the Threads cap, so an over-cap batch is
    // rejected here, before any config row is created. Admins are
    // never gated, and a missing billing client skips the gate (same
    // rule as the destination-queue gate). The gate always uses the
    // admin client, never the route's working client — in production
    // they are the same client, and in tests the working client is a
    // fake that must not answer billing queries. Unknown destination
    // ids are skipped by the key loader — createOne rejects them per
    // item downstream.
    if (resolved.context.role !== 'admin') {
      const billingClient = getBillingAdminClient();
      if (billingClient) {
        try {
          const keys = await aduDestinationKeysForCap(
            billingClient,
            resolved.context.workspaceId,
            'threads',
            parsed.data.items.map((item) => item.destinationId)
          );
          await assertFeatureAddWithinCap(
            billingClient,
            resolved.context.userId,
            'threads',
            keys
          );
        } catch (err) {
          const gateResponse = subscriptionGateResponse(err);
          if (gateResponse) return gateResponse;
          return NextResponse.json(
            { error: 'Failed to check the plan limit. Please try again.' },
            { status: 500 }
          );
        }
      }
    }
    const created: string[] = [];
    const failed: Array<{ destinationId: string; error: string }> = [];
    for (const item of parsed.data.items) {
      const schedule = resolveAduBulkItemSchedule(item, parsed.data);
      const result = await createOne(resolved.context, {
        ...item,
        timezone: schedule.timezone,
        postsPerDay: schedule.postsPerDay,
        scheduleType: parsed.data.scheduleType,
        postingTimes: schedule.postingTimes,
      });
      if (result.ok && result.id) created.push(result.id);
      else failed.push({ destinationId: item.destinationId, error: result.error ?? 'Failed to create.' });
    }
    return NextResponse.json({ created, failed }, { status: failed.length > 0 && created.length === 0 ? 400 : 201 });
  }
  const parsed = AduCreateConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  // Plan cap gate (single-add path; same rule as the bulk path above).
  if (resolved.context.role !== 'admin') {
    const billingClient = getBillingAdminClient();
    if (billingClient) {
      try {
        const keys = await aduDestinationKeysForCap(
          billingClient,
          resolved.context.workspaceId,
          'threads',
          [parsed.data.destinationId]
        );
        await assertFeatureAddWithinCap(
          billingClient,
          resolved.context.userId,
          'threads',
          keys
        );
      } catch (err) {
        const gateResponse = subscriptionGateResponse(err);
        if (gateResponse) return gateResponse;
        return NextResponse.json(
          { error: 'Failed to check the plan limit. Please try again.' },
          { status: 500 }
        );
      }
    }
  }
  const result = await createOne(resolved.context, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ id: result.id }, { status: 201 });
}
