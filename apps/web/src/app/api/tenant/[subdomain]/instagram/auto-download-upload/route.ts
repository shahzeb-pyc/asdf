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
  aduAccountKeysForCap,
  aduContext,
  ensureAduDestinationCopy,
  registerAduConfigUsage,
  aduMissingTable,
  buildAduConfigView,
  type AduConfigView,
} from '@/lib/server/adu';
import {
  assertFeatureAddWithinCap,
  getEntitlement,
  type Entitlement,
} from '@/lib/billing/entitlement';
import { logServerError } from '@/lib/server-analytics';
import {
  getBillingAdminClient,
  subscriptionGateResponse,
} from '@/lib/billing/route-helpers';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Instagram Auto Download/Upload hub list + create.
 *
 * Same shape as the Facebook hub route, destination Instagram:
 * - List is platform-filtered by construction. The Facebook hub RPCs
 *   (adu_hub_list / adu_hub_stats) are NOT used here: they have no
 *   platform filter, so they would leak Facebook configs into the
 *   Instagram hub and break pagination. Instead the route first
 *   loads this workspace's Instagram destination ids (user-connected
 *   accounts, bounded by the account count), then lists configs for
 *   those destinations only, 9 per page like Facebook.
 * - Stats follow Facebook's definitions: totalFollowers is the sum
 *   of current_followers, followersGained is the sum of net growth
 *   (current_followers minus starting_followers, floored at 0).
 * - No new tables, no migration: adu_configs / adu_reels /
 *   adu_posting_jobs are reused verbatim.
 */

function statusFilterToValue(filter: string): string | null {
  const map: Record<string, string> = {
    Active: 'active',
    Paused: 'paused',
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
    'Missing Page Access': 'missing_page_access',
    'Missing Permission': 'missing_permission',
  };
  return map[filter] ?? null;
}

function sortConfigs(
  rows: Array<Record<string, unknown>>,
  sort: string
): Array<Record<string, unknown>> {
  const byCreated = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    new Date(String(b.created_at ?? '')).getTime() -
    new Date(String(a.created_at ?? '')).getTime();
  if (sort === 'Most Followers') {
    return [...rows].sort(
      (a, b) =>
        Number(b.current_followers ?? 0) - Number(a.current_followers ?? 0) ||
        byCreated(a, b)
    );
  }
  if (sort === 'Least Followers') {
    return [...rows].sort(
      (a, b) =>
        Number(a.current_followers ?? 0) - Number(b.current_followers ?? 0) ||
        byCreated(a, b)
    );
  }
  return [...rows].sort(byCreated);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const search = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  const statusFilter = request.nextUrl.searchParams.get('status') ?? 'All Statuses';
  const sort = request.nextUrl.searchParams.get('sort') ?? 'Newest First';
  const page = Math.max(1, Number(request.nextUrl.searchParams.get('page') ?? '1') || 1);
  const pageSize = 9;
  const statusValue = statusFilterToValue(statusFilter);

  // Instagram destination ids for this workspace (the bound for
  // everything below: one ADU config per destination at most, by the
  // unique destination index).
  const { data: destinations, error: destError } = await supabase
    .from('destinations')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'instagram')
    .eq('section', 'adu')
    .limit(1000);
  if (destError) {
    if (aduMissingTable(destError)) {
      return NextResponse.json({ configs: [], total: 0, page: 1, migrationMissing: true });
    }
    console.error(`IG ADU destination list failed: code=${destError.code ?? 'unknown'}`);
    return NextResponse.json({ error: 'Failed to load accounts.' }, { status: 500 });
  }
  const destinationIds = (destinations ?? []).map((d) => (d as { id: string }).id);
  if (destinationIds.length === 0) {
    return NextResponse.json({
      configs: [],
      total: 0,
      page,
      totalPages: 0,
      stats: { totalPages: 0, followersGained: 0, totalFollowers: 0 },
    });
  }

  if (!search) {
    // DB-side page: status filter + sort + range, like Facebook's RPC.
    let query = supabase
      .from('adu_configs')
      .select('*')
      .eq('workspace_id', workspaceId)
      .in('destination_id', destinationIds);
    if (statusValue) query = query.eq('status', statusValue);
    if (sort === 'Most Followers') query = query.order('current_followers', { ascending: false });
    else if (sort === 'Least Followers') query = query.order('current_followers', { ascending: true });
    query = query.order('created_at', { ascending: false });
    const { data, error } = await query.range((page - 1) * pageSize, page * pageSize - 1);
    if (error) {
      if (aduMissingTable(error)) {
        return NextResponse.json({ configs: [], total: 0, page: 1, migrationMissing: true });
      }
      console.error(`IG ADU hub list failed: code=${error.code ?? 'unknown'}`);
      return NextResponse.json({ error: 'Failed to load accounts.' }, { status: 500 });
    }
    // Total + stats over the filtered set (bounded by destination count).
    let countQuery = supabase
      .from('adu_configs')
      .select('starting_followers, current_followers', { count: 'exact' })
      .eq('workspace_id', workspaceId)
      .in('destination_id', destinationIds);
    if (statusValue) countQuery = countQuery.eq('status', statusValue);
    const { data: statRows, count } = await countQuery;
    const total = count ?? 0;
    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const views: AduConfigView[] = [];
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      views.push(await buildAduConfigView(supabase, row as never));
    }
    const followersGained = (statRows ?? []).reduce(
      (sum, r) =>
        sum + Math.max(Number((r as { current_followers?: number }).current_followers ?? 0) - Number((r as { starting_followers?: number }).starting_followers ?? 0), 0),
      0
    );
    const totalFollowers = (statRows ?? []).reduce(
      (sum, r) => sum + Number((r as { current_followers?: number }).current_followers ?? 0),
      0
    );
    return NextResponse.json({
      configs: views,
      total,
      page,
      totalPages,
      stats: { totalPages: total, followersGained, totalFollowers },
    });
  }

  // Search path: source_username match OR destination name/external-id
  // match. Both halves are bounded by the destination set; the merge
  // is in memory over at most one config per destination.
  const escaped = search.replace(/[%_\\]/g, '');
  const { data: nameMatched } = await supabase
    .from('destinations')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'instagram')
    .eq('section', 'adu')
    .or(`name.ilike.%${escaped}%,external_destination_id.ilike.%${escaped}%`)
    .limit(1000);
  const nameMatchedIds = new Set((nameMatched ?? []).map((d) => (d as { id: string }).id));
  let searchQuery = supabase
    .from('adu_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('destination_id', destinationIds);
  if (statusValue) searchQuery = searchQuery.eq('status', statusValue);
  const { data: allRows, error: searchError } = await searchQuery;
  if (searchError) {
    if (aduMissingTable(searchError)) {
      return NextResponse.json({ configs: [], total: 0, page: 1, migrationMissing: true });
    }
    console.error(`IG ADU hub search failed: code=${searchError.code ?? 'unknown'}`);
    return NextResponse.json({ error: 'Failed to load accounts.' }, { status: 500 });
  }
  const lowered = search.toLowerCase();
  const filtered = ((allRows ?? []) as Array<Record<string, unknown>>).filter(
    (row) =>
      nameMatchedIds.has(String(row.destination_id)) ||
      String(row.source_username ?? '').toLowerCase().includes(lowered)
  );
  const sorted = sortConfigs(filtered, sort);
  const total = sorted.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);
  const views: AduConfigView[] = [];
  for (const row of pageRows) {
    views.push(await buildAduConfigView(supabase, row as never));
  }
  const followersGained = sorted.reduce(
    (sum, r) => sum + Math.max(Number(r.current_followers ?? 0) - Number(r.starting_followers ?? 0), 0),
    0
  );
  const totalFollowers = sorted.reduce((sum, r) => sum + Number(r.current_followers ?? 0), 0);
  return NextResponse.json({
    configs: views,
    total,
    page,
    totalPages,
    stats: { totalPages: total, followersGained, totalFollowers },
  });
}

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
    .eq('platform', 'instagram')
    .maybeSingle();
  if (accountError || !account) {
    return { ok: false, error: 'That Instagram account was not found in this workspace.' };
  }
  const accountRow = account as {
    id: string;
    external_account_id: string;
    display_name: string;
    avatar_url: string | null;
  };
  const ensured = await ensureAduDestinationCopy(supabase, workspaceId, 'instagram', {
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
    if (aduMissingTable(error)) {
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
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (Array.isArray((body as { items?: unknown }).items)) {
    const parsed = AduAccountBulkCreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid bulk request.' },
        { status: 400 }
      );
    }
    const fixedError = validateAduBulkFixedTimes(parsed.data);
    if (fixedError) {
      return NextResponse.json({ error: fixedError }, { status: 400 });
    }
    // Plan cap gate: the cap gate CHECKS the target (creation registers the unit, see registerAduConfigUsage)
    // accounts against the Instagram cap, so an over-cap batch is
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
    // R3: the entitlement is read once here and shared with every
    // item's register below — the only writes between the two reads
    // are the config rows themselves, so the shared answer is
    // exact. Undefined when the gate is skipped (admin / no
    // client); each register re-reads on its own then, as before.
    let sharedEntitlement: Entitlement | undefined;
    if (resolved.context.role !== 'admin') {
      const billingClient = getBillingAdminClient();
      if (!billingClient) {
        // A missing billing client skips the gate (same rule as the
        // destination-queue gate) — but the skip is logged loudly
        // (audit fix 2026-11-01): a silent skip is a fail-open.
        logServerError('[billing] ADU cap gate skipped: no billing client', null, {
          source: 'billing',
        });
      }
      if (billingClient) {
        try {
          const keys = await aduAccountKeysForCap(
            billingClient,
            resolved.context.workspaceId,
            'instagram',
            parsed.data.items.map((item) => item.accountId)
          );
          sharedEntitlement = await getEntitlement(billingClient, resolved.context.userId);
          await assertFeatureAddWithinCap(
            billingClient,
            resolved.context.userId,
            'instagram',
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
        // Cap at add (audit fix 2026-11-01): creation registers
        // the destination's unit; a registration failure rolls
        // the config back and fails this item, never a success
        // without a unit. The usage registers against the adu COPY
        // the config attaches to (createOne returns it), not the
        // account the Add dialog posted.
        const reg = await registerAduConfigUsage(resolved.context, 'instagram', result.destinationId ?? item.accountId, result.id, sharedEntitlement);
        if (reg.ok) created.push(result.id);
        else failed.push({ accountId: item.accountId, error: reg.error instanceof Error ? reg.error.message : 'Failed to register the plan limit.' });
      } else failed.push({ accountId: item.accountId, error: result.error ?? 'Failed to create.' });
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
  // R3: the entitlement is read once here and shared with the
  // register below — the only write between the two reads is the
  // config row itself, so the shared answer is exact.
  let sharedEntitlement: Entitlement | undefined;
  if (resolved.context.role !== 'admin') {
    const billingClient = getBillingAdminClient();
    if (!billingClient) {
      // A missing billing client skips the gate (same rule as the
      // destination-queue gate) — but the skip is logged loudly
      // (audit fix 2026-11-01): a silent skip is a fail-open.
      logServerError('[billing] ADU cap gate skipped: no billing client', null, {
        source: 'billing',
      });
    }
    if (billingClient) {
      try {
        const keys = await aduAccountKeysForCap(
          billingClient,
          resolved.context.workspaceId,
          'instagram',
          [parsed.data.accountId]
        );
        sharedEntitlement = await getEntitlement(billingClient, resolved.context.userId);
        await assertFeatureAddWithinCap(
          billingClient,
          resolved.context.userId,
          'instagram',
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
    const reg = await registerAduConfigUsage(resolved.context, 'instagram', result.destinationId ?? parsed.data.accountId, result.id, sharedEntitlement);
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
