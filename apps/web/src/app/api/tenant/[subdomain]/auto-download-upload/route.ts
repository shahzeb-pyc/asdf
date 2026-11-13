import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  AduBulkCreateSchema,
  AduBulkItemSchema,
  AduCreateConfigSchema,
  generateDailyRandomTimes,
  resolveAduBulkItemSchedule,
  sanitizeSourceIdentity,
  validateAduBulkFixedTimes,
  type AduBulkItem,
  type AduSourcePlatform,
} from '@fbuploadpro/contracts';
import {
  aduContext,
  aduDestinationKeysForCap,
  ensureAduDestination,
  fetchAduAccountDiscoveredPages,
  registerAduConfigUsage,
  aduMissingTable,
  aduRpcMissing,
  buildAduConfigView,
  type AduHubConfigView,
  type AduDiscoveredGraphPage,
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

function statsFromRows(statsRows: unknown): {
  totalPages: number;
  followersGained: number;
  totalFollowers: number;
} {
  // RPC names match the old in-memory stats exactly: totalFollowers
  // is the sum of current_followers, followersGained is the sum of the
  // net growth (current_followers minus starting_followers, floored at 0).
  // totalPages here is the total config count (misnamed, kept).
  const statsRow = (statsRows as Array<{
    total_count?: number;
    total_followers_sum?: number;
    net_gained_sum?: number;
  }> | null)?.[0];
  return {
    totalPages: statsRow?.total_count ?? 0,
    followersGained: statsRow?.net_gained_sum ?? 0,
    totalFollowers: statsRow?.total_followers_sum ?? 0,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  // Search/status/sort/page are applied in the database by the
  // adu_hub_list / adu_hub_stats RPCs (20261030140000): the old code
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
  // F6 (adu-opt-a): the client caches stats on a longer TTL than the
  // list, so it can ask for stats alone (`stats=only`) or skip them
  // on page turns (`stats=none`). Default (no param, or any other
  // value) is the current combined response, unchanged.
  const statsParam = request.nextUrl.searchParams.get('stats');
  if (statsParam === 'only') {
    const { data: statsRows, error: statsError } = await supabase.rpc('adu_hub_stats', {
      p_workspace_id: workspaceId,
      p_search: search || null,
      p_status: statusValue,
    });
    if (statsError) {
      // A stats-only response cannot fall back to zeros silently —
      // the stats ARE the response. A missing RPC means the ADU
      // migrations have not been applied yet (same banner as the list
      // path); any other failure is a loud 500.
      if (aduRpcMissing(statsError)) {
        return NextResponse.json({
          stats: { totalPages: 0, followersGained: 0, totalFollowers: 0 },
          migrationMissing: true,
        });
      }
      console.error(`ADU hub stats failed: code=${statsError.code ?? 'unknown'}`);
      return NextResponse.json({ error: 'Failed to load pages.' }, { status: 500 });
    }
    return NextResponse.json({ stats: statsFromRows(statsRows) });
  }
  // F2 (adu-opt-a): list + stats run concurrently instead of
  // sequentially — the same filtered scan, one trip saved per load.
  // `stats=none` skips the stats RPC entirely (the resolved stub
  // keeps the Promise.all shape; its result is never read).
  const [listResult, statsResult] = await Promise.all([
    supabase.rpc('adu_hub_list', {
      p_workspace_id: workspaceId,
      p_search: search || null,
      p_status: statusValue,
      p_sort: sort,
      p_limit: pageSize,
      p_offset: (page - 1) * pageSize,
    }),
    statsParam === 'none'
      ? Promise.resolve({ data: null, error: null })
      : supabase.rpc('adu_hub_stats', {
          p_workspace_id: workspaceId,
          p_search: search || null,
          p_status: statusValue,
        }),
  ]);
  const { data: rows, error } = listResult;
  if (error) {
    // 42P01 = ADU tables missing; 42883 / PGRST202 = the RPC itself
    // missing, which also means the ADU migrations have not been
    // applied yet. PGRST202 is the case PostgREST actually returns
    // for a missing RPC — without it, an unapplied migration renders
    // as a bare "Failed to load pages." with no migration banner.
    if (aduRpcMissing(error)) {
      return NextResponse.json({ configs: [], total: 0, page: 1, migrationMissing: true });
    }
    console.error(`ADU hub list failed: code=${error.code ?? 'unknown'}`);
    return NextResponse.json({ error: 'Failed to load pages.' }, { status: 500 });
  }
  const listRows = (rows ?? []) as Array<Record<string, unknown> & { total_count?: number }>;
  const total = listRows[0]?.total_count ?? 0;
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  // Hub views are slim (F7) and built concurrently — each build is
  // independent and Promise.all preserves row order.
  const views: AduHubConfigView[] = await Promise.all(
    listRows.map((row) => buildAduConfigView(supabase, row as never, { hub: true })),
  );
  if (statsParam === 'none') {
    return NextResponse.json({ configs: views, total, page, totalPages });
  }
  const { data: statsRows, error: statsError } = statsResult;
  if (statsError) {
    console.error(`ADU hub stats failed: code=${statsError.code ?? 'unknown'}`);
  }
  // A failed stats RPC reads as zeros (the pre-existing behaviour:
  // the RPC returns no rows on error, so the sums fall back to 0).
  // Ignore any rows that arrive alongside the error — the stats are
  // untrusted once the call has failed.
  const stats = statsError
    ? { totalPages: total, followersGained: 0, totalFollowers: 0 }
    : { ...statsFromRows(statsRows), totalPages: total };
  return NextResponse.json({
    configs: views,
    total,
    page,
    totalPages,
    stats,
  });
}

import type { SupabaseClient } from '@supabase/supabase-js';

interface AduRouteContext {
  workspaceId: string;
  supabase: SupabaseClient;
}

/**
 * A discovered page reference: a Facebook page id under one account,
 * as returned by the Pages picker's discover route. The server never
 * trusts a client-supplied page token — submit re-discovers the
 * account's pages and matches by fbPageId (see below), so a forged
 * reference cannot attach an arbitrary page to this workspace.
 */
const AduDiscoveredPageRefSchema = z.object({
  fbPageId: z.string().min(1).max(64),
  accountId: z.string().uuid(),
});

/**
 * Bulk/single items accept either an existing `destinationId` or a
 * `discovered` page reference — never both, never neither. The
 * contracts schemas cannot express the alternative (they require
 * `destinationId`), so the extension lives here at this route's
 * boundary; the shared schedule/timezone validation below still runs
 * on the contracts schemas over the resolved items.
 */
const AduBulkItemWithDiscoverySchema = AduBulkItemSchema.extend({
  destinationId: AduBulkItemSchema.shape.destinationId.optional(),
  discovered: AduDiscoveredPageRefSchema.optional(),
}).superRefine((item, ctx) => {
  if (Boolean(item.destinationId) === Boolean(item.discovered)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Each page needs either an existing destination or a discovered Facebook page.',
    });
  }
});

const AduBulkCreateWithDiscoverySchema = AduBulkCreateSchema.extend({
  items: z.array(AduBulkItemWithDiscoverySchema).min(1).max(1000),
});

// `AduCreateConfigSchema` is a ZodEffects (its fixed-times check is a
// `.superRefine`), so it has no `.extend`/`.shape` — unwrap the inner
// object first. Unwrapping drops the original refinement, so the
// fixed-times check is re-applied here verbatim (keep in sync with
// `AduCreateConfigSchema` in `packages/contracts/src/domain/adu.ts`).
const AduCreateConfigWithDiscoverySchema = AduCreateConfigSchema.innerType()
  .extend({
    destinationId: AduCreateConfigSchema.innerType().shape.destinationId.optional(),
    discovered: AduDiscoveredPageRefSchema.optional(),
  })
  .superRefine((item, ctx) => {
    if (item.scheduleType === 'fixed') {
      if (!item.postingTimes || item.postingTimes.length !== item.postsPerDay) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Fixed posting requires ${item.postsPerDay} posting times.`,
          path: ['postingTimes'],
        });
      }
    }
    if (Boolean(item.destinationId) === Boolean(item.discovered)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Each page needs either an existing destination or a discovered Facebook page.',
      });
    }
  });

type DiscoverFetchResult =
  | { ok: true; pages: AduDiscoveredGraphPage[] }
  | { ok: false; error: string };

/**
 * Resolves one discovered reference to a real destination id: the
 * account's pages are re-fetched server-side, the fbPageId must
 * match one of them, and the destinations row is ensured (upserted
 * with the encrypted per-page token) before any config is created.
 */
async function resolveDiscoveredPage(
  ctx: AduRouteContext,
  discovered: { fbPageId: string; accountId: string },
  fetchForAccount: (accountId: string) => Promise<DiscoverFetchResult>,
): Promise<{ ok: true; destinationId: string } | { ok: false; error: string }> {
  const fetched = await fetchForAccount(discovered.accountId);
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const page = fetched.pages.find((p) => p.fbPageId === discovered.fbPageId);
  if (!page) {
    return {
      ok: false,
      error: 'That Facebook page was not found on this account.',
    };
  }
  const ensured = await ensureAduDestination(
    ctx.supabase,
    ctx.workspaceId,
    discovered.accountId,
    page,
  );
  if (!ensured.ok) return { ok: false, error: ensured.error };
  return { ok: true, destinationId: ensured.destinationId };
}

/**
 * Resolves discovered bulk items to real destination ids. One Graph
 * fetch per account, cached for the request. Items that fail to
 * resolve land in `failed` with the Facebook page id as their key.
 * The destinations upsert runs before the shared fixed-times
 * validation and cap gate (both operate on destination ids); a later
 * validation failure can leave an orphan destinations row behind,
 * which is benign: it is the same page record a Pages import would
 * have created.
 */
async function resolveDiscoveredBulkItems(
  ctx: AduRouteContext,
  items: Array<z.infer<typeof AduBulkItemWithDiscoverySchema>>,
): Promise<{
  resolved: AduBulkItem[];
  failed: Array<{ destinationId: string; error: string }>;
}> {
  const { workspaceId, supabase } = ctx;
  const pagesByAccount = new Map<string, Promise<DiscoverFetchResult>>();
  const fetchForAccount = (accountId: string) => {
    const cached = pagesByAccount.get(accountId);
    if (cached) return cached;
    const pending = fetchAduAccountDiscoveredPages(
      supabase,
      workspaceId,
      accountId,
    );
    pagesByAccount.set(accountId, pending);
    return pending;
  };
  const resolved: AduBulkItem[] = [];
  const failed: Array<{ destinationId: string; error: string }> = [];
  for (const item of items) {
    if (item.destinationId) {
      resolved.push({
        destinationId: item.destinationId,
        sourcePlatform: item.sourcePlatform,
        sourceUsername: item.sourceUsername,
        schedule: item.schedule,
      });
      continue;
    }
    // superRefine guarantees `discovered` is present here; the
    // guard below is belt and braces, never silent.
    if (!item.discovered) {
      failed.push({
        destinationId: '',
        error:
          'Each page needs either an existing destination or a discovered Facebook page.',
      });
      continue;
    }
    const result = await resolveDiscoveredPage(ctx, item.discovered, fetchForAccount);
    if (!result.ok) {
      failed.push({ destinationId: item.discovered.fbPageId, error: result.error });
      continue;
    }
    resolved.push({
      destinationId: result.destinationId,
      sourcePlatform: item.sourcePlatform,
      sourceUsername: item.sourceUsername,
      schedule: item.schedule,
    });
  }
  return { resolved, failed };
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
    .eq('platform', 'facebook')
    .eq('section', 'adu')
    .maybeSingle();
  if (destError || !destination) {
    return { ok: false, error: 'That Facebook page was not found in this workspace.' };
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
      return { ok: false, error: 'This page is already configured.' };
    }
    if (aduMissingTable(error)) {
      return {
        ok: false,
        error: 'The ADU tables have not been created yet. Apply migration 20261030120001_adu.sql, then try again.',
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
  // Bulk: { items: [...], timezone, postsPerDay, scheduleType, postingTimes? }
  // Items carry either `destinationId` or a `discovered` page reference.
  if (Array.isArray((body as { items?: unknown }).items)) {
    const parsed = AduBulkCreateWithDiscoverySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid bulk request.' },
        { status: 400 }
      );
    }
    // Discovered items resolve to real destination ids first, so the
    // shared validation, cap gate, and create loop below all operate
    // on destination ids exactly as before. Items that fail to
    // resolve are reported per item, never dropped silently.
    const { resolved: resolvedItems, failed: resolveFailed } =
      await resolveDiscoveredBulkItems(resolved.context, parsed.data.items);
    // Fixed-times validation lives in contracts (shared + per-item
    // 'separate' schedules, old wording), so the route and the tests
    // cannot drift apart.
    const fixedError = validateAduBulkFixedTimes({ ...parsed.data, items: resolvedItems });
    if (fixedError) {
      return NextResponse.json({ error: fixedError }, { status: 400 });
    }
    // Plan cap gate: the cap gate CHECKS the target (creation registers the unit, see registerAduConfigUsage) pages
    // against the Facebook cap, so an over-cap batch is rejected
    // here, before any config row is created. Admins are never
    // gated, and a missing billing client skips the gate (same rule
    // as the destination-queue gate). The gate always uses the admin
    // client, never the route's working client — in production they
    // are the same client, and in tests the working client is a fake
    // that must not answer billing queries. Unknown destination ids
    // are skipped by the key loader — createOne rejects them per
    // item downstream.
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
          const keys = await aduDestinationKeysForCap(
            billingClient,
            resolved.context.workspaceId,
            'facebook',
            resolvedItems.map((item) => item.destinationId)
          );
          sharedEntitlement = await getEntitlement(billingClient, resolved.context.userId);
          await assertFeatureAddWithinCap(
            billingClient,
            resolved.context.userId,
            'facebook',
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
    const failed: Array<{ destinationId: string; error: string }> = [...resolveFailed];
    for (const item of resolvedItems) {
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
        const reg = await registerAduConfigUsage(resolved.context, 'facebook', item.destinationId, result.id, sharedEntitlement);
        if (reg.ok) created.push(result.id);
        else failed.push({ destinationId: item.destinationId, error: reg.error instanceof Error ? reg.error.message : 'Failed to register the plan limit.' });
      } else failed.push({ destinationId: item.destinationId, error: result.error ?? 'Failed to create.' });
    }
    return NextResponse.json({ created, failed }, { status: failed.length > 0 && created.length === 0 ? 400 : 201 });
  }
  const parsed = AduCreateConfigWithDiscoverySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  // A discovered page resolves to a real destination id first (same
  // re-discovery + upsert as the bulk path); afterwards this path is
  // identical to the existing-destination path.
  let destinationId = parsed.data.destinationId;
  if (!destinationId && parsed.data.discovered) {
    const result = await resolveDiscoveredPage(
      resolved.context,
      parsed.data.discovered,
      (accountId) =>
        fetchAduAccountDiscoveredPages(
          resolved.context.supabase,
          resolved.context.workspaceId,
          accountId,
        ),
    );
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    destinationId = result.destinationId;
  }
  if (!destinationId) {
    return NextResponse.json(
      { error: 'Each page needs either an existing destination or a discovered Facebook page.' },
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
        const keys = await aduDestinationKeysForCap(
          billingClient,
          resolved.context.workspaceId,
          'facebook',
          [destinationId]
        );
        sharedEntitlement = await getEntitlement(billingClient, resolved.context.userId);
        await assertFeatureAddWithinCap(
          billingClient,
          resolved.context.userId,
          'facebook',
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
  const result = await createOne(resolved.context, { ...parsed.data, destinationId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  if (result.id) {
    const reg = await registerAduConfigUsage(resolved.context, 'facebook', destinationId, result.id, sharedEntitlement);
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
