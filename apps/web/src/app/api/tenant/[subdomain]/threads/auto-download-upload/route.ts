import { type NextRequest, NextResponse } from 'next/server';
import {
  AduAccountBulkCreateSchema,
  AduAccountCreateConfigSchema,
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
import { aduAccountKeysForCap, ensureAduDestinationCopy, registerAduConfigUsage, parseAduHubListRows, parseAduHubStatsRow, type AduConfigView } from '@/lib/server/adu';
import { statusFilterToValue } from '@/lib/adu-hub-helpers';
import {
  assertFeatureAddWithinCap,
  getEntitlement,
  type Entitlement,
} from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  subscriptionGateResponse,
} from '@/lib/billing/route-helpers';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  // Search/status/sort/page are applied in the database by the
  // unified adu_hub_list / adu_hub_stats RPCs (20261113170000, F21),
  // called here with p_platform 'threads'. The old code loaded every
  // config for the workspace and sliced 9/page in memory, which
  // silently truncated past PostgREST's 1,000-row limit. Only the 9
  // rows of the requested page are ever built into views, and
  // totals/stats come from the database, not from a sliced array.
  const search = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  const statusFilter = request.nextUrl.searchParams.get('status') ?? 'All Statuses';
  const sort = request.nextUrl.searchParams.get('sort') ?? 'Newest First';
  const page = Math.max(1, Number(request.nextUrl.searchParams.get('page') ?? '1') || 1);
  const pageSize = 9;
  const statusValue = statusFilterToValue(statusFilter);
  const { data: rows, error } = await supabase.rpc('adu_hub_list', {
    p_workspace_id: workspaceId,
    p_platform: 'threads',
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
  // List rows are validated against the contracts schema at this
  // boundary (F21): a malformed row is a loud 500, never a wrong hub.
  const listRows = parseAduHubListRows(rows);
  if (!listRows) {
    console.error('ADU hub list returned an invalid row');
    return NextResponse.json({ error: 'Failed to load accounts.' }, { status: 500 });
  }
  const total = listRows[0]?.total_count ?? 0;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const views: AduConfigView[] = [];
  for (const row of listRows) {
    views.push((await loadThreadsAduConfigView(supabase, workspaceId, (row as { id: string }).id))!);
  }
  const { data: statsRows, error: statsError } = await supabase.rpc('adu_hub_stats', {
    p_workspace_id: workspaceId,
    p_platform: 'threads',
    p_search: search || null,
    p_status: statusValue,
  });
  if (statsError) {
    console.error(`ADU hub stats failed: code=${statsError.code ?? 'unknown'}`);
  }
  // RPC names match the old in-memory stats exactly: totalFollowers
  // is the sum of current_followers, followersGained is the sum of the
  // net growth (current_followers minus starting_followers, floored at 0).
  // A failed stats RPC reads as zeros (the pre-existing behaviour);
  // a malformed stats row is treated the same way (logged, then zeros).
  const parsedStats = statsError ? null : parseAduHubStatsRow(statsRows);
  if (!statsError && !parsedStats) {
    console.error('ADU hub stats returned an invalid row');
  }
  return NextResponse.json({
    configs: views,
    total,
    page,
    totalPages,
    stats: {
      totalPages: total,
      followersGained: parsedStats?.net_gained_sum ?? 0,
      totalFollowers: parsedStats?.total_followers_sum ?? 0,
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
    accountId: string;
    sourcePlatform: AduSourcePlatform;
    sourceUsername: string;
    timezone: string;
    postsPerDay: number;
    scheduleType: 'dailyrandom' | 'fixed';
    postingTimes?: string[] | undefined;
  }
): Promise<{ ok: boolean; id?: string; destinationId?: string; error?: string }> {
  const { workspaceId, supabase } = ctx;
  const username = sanitizeSourceIdentity(input.sourcePlatform, input.sourceUsername);
  if (!username) return { ok: false, error: 'Enter a source username.' };
  // The account is the identity source (spec 174 2A): the Add dialog
  // sources live from the connected account, never from a table.
  // The config attaches to this section's own copy, created here
  // when it does not exist yet (spec 174 1B). A config must never
  // attach to another section's row.
  const { data: account, error: accountError } = await supabase
    .from('social_accounts')
    .select('id, external_account_id, display_name, avatar_url')
    .eq('workspace_id', workspaceId)
    .eq('id', input.accountId)
    .eq('platform', 'threads')
    .maybeSingle();
  if (accountError || !account) {
    return { ok: false, error: 'That Threads account was not found in this workspace.' };
  }
  const accountRow = account as {
    id: string;
    external_account_id: string;
    display_name: string;
    avatar_url: string | null;
  };
  const ensured = await ensureAduDestinationCopy(supabase, workspaceId, 'threads', {
    account_id: accountRow.id,
    external_destination_id: accountRow.external_account_id,
    name: accountRow.display_name,
    avatar_url: accountRow.avatar_url ?? null,
    // The account row carries no metadata: the copy keeps its own
    // (followers) when it exists, and starts empty when it does not.
    metadata: null,
  });
  if (!ensured.ok) return { ok: false, error: ensured.error };
  const destination = { id: ensured.destinationId, metadata: ensured.metadata };
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
      destination_id: destination.id,
      source_platform: input.sourcePlatform,
      source_username: username,
      timezone: input.timezone,
      posts_per_day: input.postsPerDay,
      schedule_type: input.scheduleType,
      posting_times: postingTimes,
      status: 'active',
      sync_status: 'pending',
      starting_followers: startingFollowers,
      current_followers: startingFollowers,
      // Spec 162 (send-back fix): the creation path writes
      // current_followers, so it stamps the last-updated time too —
      // the migration header promises the timestamp is set by the
      // daily worker AND by the ADU creation paths.
      followers_updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') {
      return { ok: false, error: 'This account is already configured.' };
    }
    if (threadsAduMissingTable(error)) {
      return {
        ok: false,
        error: 'The ADU tables have not been created yet. Apply migration 20261030120001_adu.sql, then try again.',
      };
    }
    return { ok: false, error: error.message };
  }
  // The adu copy id is returned alongside the config id so the
  // caller registers the plan usage against the copy the config
  // actually attaches to (spec 174 2A) — never the picked id, which
  // no longer exists as an input.
  return { ok: true, id: data.id as string, destinationId: destination.id };
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
    const parsed = AduAccountBulkCreateSchema.safeParse(body);
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
    // fake that must not answer billing queries. Unknown account
    // ids are skipped by the key loader — createOne rejects them per
    // item downstream. The gate keys come from the ACCOUNTS (spec
    // 174 2A): the adu copy the add creates may not exist yet when
    // the pre-create gate runs.
    // R3 + C1 (rework): the entitlement is read once here and
    // shared with every item's register below — the only writes
    // between the two reads are the config rows themselves, so the
    // shared answer is exact. React `cache()` does not memoize in
    // route handlers, so this explicit plumbing — not the cached
    // read — is what makes one gate + N registers cost one
    // entitlement read. Undefined when the gate is skipped (admin
    // / no client); each register re-reads on its own then, as
    // before.
    let sharedEntitlement: Entitlement | undefined;
    if (resolved.context.role !== 'admin') {
      const billingClient = getBillingAdminClient();
      if (billingClient) {
        try {
          const keys = await aduAccountKeysForCap(
            billingClient,
            resolved.context.workspaceId,
            'threads',
            parsed.data.items.map((item) => item.accountId)
          );
          sharedEntitlement = await getEntitlement(billingClient, resolved.context.userId);
          await assertFeatureAddWithinCap(
            billingClient,
            resolved.context.userId,
            'threads',
            keys,
            'adu',
            undefined,
            sharedEntitlement
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
    const failed: Array<{ accountId: string; error: string }> = [];
    for (const item of parsed.data.items) {
      const schedule = resolveAduBulkItemSchedule(item, parsed.data);
      const result = await createOne(resolved.context, {
        ...item,
        timezone: schedule.timezone,
        postsPerDay: schedule.postsPerDay,
        scheduleType: parsed.data.scheduleType,
        postingTimes: schedule.postingTimes,
      });
      if (result.ok && result.id) {
        // Cap at add (plan-check B1): creation registers the
        // destination's Threads unit; a registration failure rolls
        // the config back and fails this item, never a success
        // without a unit. The usage registers against the adu COPY
        // the config attaches to (createOne returns it), not the
        // account the Add dialog posted.
        const reg = await registerAduConfigUsage(resolved.context, 'threads', result.destinationId ?? item.accountId, result.id, sharedEntitlement);
        if (reg.ok) created.push(result.id);
        else failed.push({ accountId: item.accountId, error: reg.error instanceof Error ? reg.error.message : 'Failed to register the plan limit.' });
      }
      else failed.push({ accountId: item.accountId, error: result.error ?? 'Failed to create.' });
    }
    return NextResponse.json({ created, failed }, { status: failed.length > 0 && created.length === 0 ? 400 : 201 });
  }
  const parsed = AduAccountCreateConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  // Plan cap gate (single-add path; same rule as the bulk path above).
  // R3 + C1 (rework): the entitlement is read once here and shared
  // with the register below — the only write between the two reads
  // is the config row itself, so the shared answer is exact (see
  // the bulk path: explicit plumbing, not the cached read, is the
  // dedup in route handlers).
  let sharedEntitlement: Entitlement | undefined;
  if (resolved.context.role !== 'admin') {
    const billingClient = getBillingAdminClient();
    if (billingClient) {
      try {
        const keys = await aduAccountKeysForCap(
          billingClient,
          resolved.context.workspaceId,
          'threads',
          [parsed.data.accountId]
        );
        sharedEntitlement = await getEntitlement(billingClient, resolved.context.userId);
        await assertFeatureAddWithinCap(
          billingClient,
          resolved.context.userId,
          'threads',
          keys,
          'adu',
          undefined,
          sharedEntitlement
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
  if (result.id) {
    // Cap at add (plan-check B1): creation registers the
    // destination's Threads unit; a registration failure rolls the
    // config back and reports the gate error, never a success
    // without a unit.
    const reg = await registerAduConfigUsage(resolved.context, 'threads', result.destinationId ?? parsed.data.accountId, result.id, sharedEntitlement);
    if (!reg.ok) {
      const gateResponse = subscriptionGateResponse(reg.error);
      if (gateResponse) return gateResponse;
      return NextResponse.json(
        { error: 'The plan limit could not be registered. Please try again.' },
        { status: 500 }
      );
    }
  }
  return NextResponse.json({ id: result.id }, { status: 201 });
}
