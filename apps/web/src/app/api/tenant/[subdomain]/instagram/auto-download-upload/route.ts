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
  aduContext,
  aduDestinationKeysForCap,
  registerAduConfigUsage,
  aduMissingTable,
  buildAduConfigView,
  type AduConfigView,
} from '@/lib/server/adu';
import { assertFeatureAddWithinCap } from '@/lib/billing/entitlement';
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
 *   of followers_gained, followersGained is the sum of net growth
 *   (followers_gained minus followers_count, floored at 0).
 * - No new tables, no migration: adu_configs / adu_reels /
 *   adu_posting_jobs are reused verbatim.
 */

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
        Number(b.followers_gained ?? 0) - Number(a.followers_gained ?? 0) ||
        byCreated(a, b)
    );
  }
  if (sort === 'Least Followers') {
    return [...rows].sort(
      (a, b) =>
        Number(a.followers_gained ?? 0) - Number(b.followers_gained ?? 0) ||
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
    if (sort === 'Most Followers') query = query.order('followers_gained', { ascending: false });
    else if (sort === 'Least Followers') query = query.order('followers_gained', { ascending: true });
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
      .select('followers_count, followers_gained', { count: 'exact' })
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
        sum + Math.max(Number((r as { followers_gained?: number }).followers_gained ?? 0) - Number((r as { followers_count?: number }).followers_count ?? 0), 0),
      0
    );
    const totalFollowers = (statRows ?? []).reduce(
      (sum, r) => sum + Number((r as { followers_gained?: number }).followers_gained ?? 0),
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
    (sum, r) => sum + Math.max(Number(r.followers_gained ?? 0) - Number(r.followers_count ?? 0), 0),
    0
  );
  const totalFollowers = sorted.reduce((sum, r) => sum + Number(r.followers_gained ?? 0), 0);
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
    .eq('platform', 'instagram')
    .maybeSingle();
  if (destError || !destination) {
    return { ok: false, error: 'That Instagram account was not found in this workspace.' };
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
    if (aduMissingTable(error)) {
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
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  if (Array.isArray((body as { items?: unknown }).items)) {
    const parsed = AduBulkCreateSchema.safeParse(body);
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
    // fake that must not answer billing queries. Unknown destination
    // ids are skipped by the key loader — createOne rejects them per
    // item downstream.
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
          const keys = await aduDestinationKeysForCap(
            billingClient,
            resolved.context.workspaceId,
            'instagram',
            parsed.data.items.map((item) => item.destinationId)
          );
          await assertFeatureAddWithinCap(
            billingClient,
            resolved.context.userId,
            'instagram',
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
      if (result.ok && result.id) {
        // Cap at add (audit fix 2026-11-01): creation registers
        // the destination's unit; a registration failure rolls
        // the config back and fails this item, never a success
        // without a unit.
        const reg = await registerAduConfigUsage(resolved.context, 'instagram', item.destinationId, result.id);
        if (reg.ok) created.push(result.id);
        else failed.push({ destinationId: item.destinationId, error: reg.error instanceof Error ? reg.error.message : 'Failed to register the plan limit.' });
      } else failed.push({ destinationId: item.destinationId, error: result.error ?? 'Failed to create.' });
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
        const keys = await aduDestinationKeysForCap(
          billingClient,
          resolved.context.workspaceId,
          'instagram',
          [parsed.data.destinationId]
        );
        await assertFeatureAddWithinCap(
          billingClient,
          resolved.context.userId,
          'instagram',
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
  if (result.id) {
    const reg = await registerAduConfigUsage(resolved.context, 'instagram', parsed.data.destinationId, result.id);
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
