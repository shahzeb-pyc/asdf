import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import {
  getSessionSecret,
  verifySessionToken,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createR2S3Client, getR2Config } from '@/lib/storage';

/**
 * Internal health tier (spec 116). Authenticated only — never public.
 *
 * Authorization: either a Bearer token matching INTERNAL_HEALTH_TOKEN, or
 * a signed session cookie whose role is 'admin'. Fails closed otherwise.
 *
 * Expensive / revealing checks live here only: R2 HeadBucket, DB latency,
 * worker heartbeat age, queue backlog, and stored Facebook domain-health
 * aggregates. The Facebook Graph API is NEVER called from any health path.
 */

export const HEARTBEAT_STALE_SECONDS = 180; // ~3 missed 1-minute ticks
export const STUCK_PUBLISHING_MINUTES = 10; // matches the worker recovery threshold
const R2_PROBE_TIMEOUT_MS = 1000;

// Unified status vocabularies (Phase 7: the health tier measures the
// unified world only — destinations + social_accounts, platform
// 'facebook'). The payload keys keep their names; the values are the
// unified statuses.
const PAGE_STATUSES = ['active', 'rate_limited', 'disconnected', 'error'] as const;
const ACCOUNT_STATUSES = ['active', 'expired', 'revoked', 'error'] as const;

export interface InternalHealthPayload {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  checks: {
    database: { ok: boolean; latencyMs: number | null };
    heartbeat: {
      ok: boolean;
      ageSeconds: number | null;
      lastRunAt: string | null;
      lastSuccessAt: string | null;
      lastSkipReason: string | null;
      claimed: number;
      settled: number;
    };
    queue: {
      dueCount: number;
      oldestDueAgeSeconds: number | null;
      stuckPublishingCount: number;
    };
    storage: { ok: boolean };
    facebook: {
      pagesByStatus: Record<string, number>;
      accountsByStatus: Record<string, number>;
      /**
       * Spec 174 3B: the daily section check's flag, evaluated live
       * from the same predicates the worker cron uses (unlabelled
       * destination rows + children on the wrong section's row),
       * scoped to Facebook like the rest of this block. Live
       * computation (no stored run result, no new table) means the
       * flag can never go stale relative to the data; the cron's
       * job is the loud alert, this flag is the current state.
       * A failed count query reads as 0 here, the route's usual
       * fail-soft rule — the worker cron is the fail-loud side.
       */
      sectionCheck: {
        dirty: boolean;
        unsectionedDestinations: number;
        wrongSectionChildren: number;
        checkedAt: string;
      };
    };
  };
}

export interface InternalHealthDeps {
  // Supabase client (service role) — the app's client-factory type
  // (spec 137 §3.7: the untyped generic lives in the factory, not here).
  db?: SupabaseClient;
  checkStorage?: () => Promise<boolean>;
  now?: Date;
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function authorizeInternalRequest(
  request: Request
): Promise<boolean> {
  const internalToken = process.env.INTERNAL_HEALTH_TOKEN;
  const authHeader = request.headers.get('authorization') || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (internalToken && bearer && tokensMatch(bearer, internalToken)) {
    return true;
  }

  const cookieHeader = request.headers.get('cookie') || '';
  const match = /(?:^|;\s*)fbup_session=([^;]+)/.exec(cookieHeader);
  if (match?.[1]) {
    try {
      const session = await verifySessionToken(
        decodeURIComponent(match[1]),
        getSessionSecret()
      );
      return session.role === 'admin';
    } catch {
      return false;
    }
  }
  return false;
}

async function defaultCheckStorage(): Promise<boolean> {
  const config = getR2Config();
  if (!config) return false;
  try {
    const client = createR2S3Client(config);
    await client.send(new HeadBucketCommand({ Bucket: config.bucketName }), {
      abortSignal: AbortSignal.timeout(R2_PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

async function countByStatus(
  db: SupabaseClient,
  table: string,
  statuses: readonly string[],
  platform?: string,
  // When given, the count is per section (spec 174 1B): one bucket
  // per section × status, keyed `section:status`. A null entry
  // counts rows with no section yet, keyed `unsectioned:status` —
  // the Phase 4 straggler population, visible here until it is
  // backfilled to zero.
  sections?: Array<string | null>
): Promise<Record<string, number>> {
  const buckets = (sections ?? [null]).flatMap((section) =>
    statuses.map((status) => ({ section, status }))
  );
  const entries = await Promise.all(
    buckets.map(async ({ section, status }) => {
      try {
        let query = db
          .from(table)
          .select('id', { head: true, count: 'exact' })
          .eq('status', status);
        if (platform) {
          query = query.eq('platform', platform);
        }
        if (sections !== undefined) {
          query =
            section === null
              ? query.is('section', null)
              : query.eq('section', section);
        }
        const { count, error } = await query;
        const key =
          sections === undefined ? status : `${section ?? 'unsectioned'}:${status}`;
        return [key, error ? 0 : (count ?? 0)] as const;
      } catch {
        const key =
          sections === undefined ? status : `${section ?? 'unsectioned'}:${status}`;
        return [key, 0] as const;
      }
    })
  );
  return Object.fromEntries(entries);
}

type HeartbeatCheck = InternalHealthPayload['checks']['heartbeat'];
type QueueCheck = InternalHealthPayload['checks']['queue'];
type QueueTableCounts = QueueCheck;

const EMPTY_HEARTBEAT: HeartbeatCheck = {
  ok: false,
  ageSeconds: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastSkipReason: null,
  claimed: 0,
  settled: 0,
};

const EMPTY_QUEUE_TABLE: QueueTableCounts = {
  dueCount: 0,
  oldestDueAgeSeconds: null,
  stuckPublishingCount: 0,
};

const EMPTY_QUEUE: QueueCheck = { ...EMPTY_QUEUE_TABLE };

async function checkHeartbeat(db: SupabaseClient, now: Date): Promise<HeartbeatCheck> {
  try {
    const { data, error } = await db
      .from('worker_heartbeats')
      .select(
        'last_run_at, last_success_at, last_claimed_count, last_settled_count, last_skip_reason'
      )
      .eq('worker_name', 'fbuploadpro-worker')
      .maybeSingle();
    if (error || !data) return EMPTY_HEARTBEAT;
    const lastSuccessAt = data.last_success_at as string | null;
    const ageSeconds = lastSuccessAt
      ? Math.max(
          0,
          Math.floor((now.getTime() - new Date(lastSuccessAt).getTime()) / 1000)
        )
      : null;
    return {
      ok: ageSeconds !== null && ageSeconds <= HEARTBEAT_STALE_SECONDS,
      ageSeconds,
      lastRunAt: data.last_run_at ?? null,
      lastSuccessAt,
      lastSkipReason: data.last_skip_reason ?? null,
      claimed: Number(data.last_claimed_count ?? 0),
      settled: Number(data.last_settled_count ?? 0),
    };
  } catch {
    return EMPTY_HEARTBEAT;
  }
}

/**
 * Measure the unified queue table with the publishing engine's own
 * predicates.
 *
 * Due — matched to `claim_due_queue_items` (supabase/migrations/
 * 20261022120000_unified_schema_migration.sql §6a, grouped-usage
 * rewrite in 20261022140000_claim_rpc_grouped_usage.sql):
 *   status = 'queued' AND scheduled_time <= now()
 * The claim RPC additionally filters by platform / lane kind /
 * destination & account health — those are per-claim eligibility, not
 * backlog, so the health probe counts the full due set.
 *
 * Stuck — matched to `recover_stuck_publishing_items` and the worker
 * claimer (`apps/worker/src/claimer.ts`: RECOVERY_TIMEOUT_MINUTES = 10,
 * mirrored by STUCK_PUBLISHING_MINUTES above):
 *   status = 'publishing' AND
 *     COALESCE(claimed_at, updated_at) <= now() - 10m
 * The predicate is expressed as a PostgREST `.or()`: a non-null
 * claimed_at that is stale, or a null claimed_at with a stale updated_at
 * (a `.lte` on claimed_at alone never matches NULL rows).
 */
async function measureQueueTable(
  db: SupabaseClient,
  now: Date
): Promise<QueueTableCounts> {
  try {
    const timestamp = now.toISOString();
    const stuckBefore = new Date(
      now.getTime() - STUCK_PUBLISHING_MINUTES * 60 * 1000
    ).toISOString();
    const dueQuery = await db
      .from('queue_items')
      .select('id', { head: true, count: 'exact' })
      .eq('status', 'queued')
      .lte('scheduled_time', timestamp);
    const stuckQuery = await db
      .from('queue_items')
      .select('id', { head: true, count: 'exact' })
      .eq('status', 'publishing')
      .or(
        `claimed_at.lte.${stuckBefore},and(claimed_at.is.null,updated_at.lte.${stuckBefore})`
      );
    const { data: oldest } = await db
      .from('queue_items')
      .select('scheduled_time')
      .eq('status', 'queued')
      .lte('scheduled_time', timestamp)
      .order('scheduled_time', { ascending: true })
      .limit(1)
      .maybeSingle();
    let oldestDueAgeSeconds: number | null = null;
    if (oldest?.scheduled_time) {
      oldestDueAgeSeconds = Math.max(
        0,
        Math.floor(
          (now.getTime() - new Date(oldest.scheduled_time).getTime()) / 1000
        )
      );
    }
    return {
      dueCount: dueQuery.error ? 0 : (dueQuery.count ?? 0),
      oldestDueAgeSeconds,
      stuckPublishingCount: stuckQuery.error ? 0 : (stuckQuery.count ?? 0),
    };
  } catch {
    return EMPTY_QUEUE_TABLE;
  }
}

async function checkQueue(db: SupabaseClient, now: Date): Promise<QueueCheck> {
  try {
    // The unified queue_items table is the only queue there is — the
    // table the worker claimer drains via
    // claim_due_queue_items(platform, …) and consumers load
    // (apps/worker/src/claimer.ts, consumers.ts).
    return await measureQueueTable(db, now);
  } catch {
    return EMPTY_QUEUE;
  }
}

type SectionCheckFlag = InternalHealthPayload['checks']['facebook']['sectionCheck'];

/** Fail-soft count read: a failed count query reads as 0, the route's usual rule. */
function countOrZero(result: { count: number | null; error: unknown }): number {
  return result.error ? 0 : (result.count ?? 0);
}

/**
 * Spec 174 3B — the section-integrity flag. Same predicates as the
 * worker's daily section check (apps/worker/src/section-check.ts),
 * scoped to Facebook destinations. `neq` never matches a NULL
 * section, so children on unlabelled rows are covered by the
 * unsectioned count, not the wrong-section counts.
 */
async function checkSectionIntegrity(
  db: SupabaseClient,
  now: Date
): Promise<SectionCheckFlag> {
  const checkedAt = now.toISOString();
  try {
    const [unsectionedDestinations, slots, queueItems, aduConfigs, slotClaims] =
      await Promise.all([
        db
          .from('destinations')
          .select('id', { head: true, count: 'exact' })
          .eq('platform', 'facebook')
          .is('section', null)
          .then(countOrZero),
        db
          .from('posting_slots')
          .select('id, destinations!inner(section, platform)', {
            head: true,
            count: 'exact',
          })
          .eq('destinations.platform', 'facebook')
          .neq('destinations.section', 'schedule')
          .then(countOrZero),
        db
          .from('queue_items')
          .select('id, destinations!inner(section, platform)', {
            head: true,
            count: 'exact',
          })
          .eq('destinations.platform', 'facebook')
          .neq('destinations.section', 'schedule')
          .then(countOrZero),
        db
          .from('adu_configs')
          .select('id, destinations!inner(section, platform)', {
            head: true,
            count: 'exact',
          })
          .eq('destinations.platform', 'facebook')
          .neq('destinations.section', 'adu')
          .then(countOrZero),
        db
          .from('posting_slot_claims')
          .select('id, destinations!inner(section, platform)', {
            head: true,
            count: 'exact',
          })
          .eq('destinations.platform', 'facebook')
          .neq('destinations.section', 'schedule')
          .then(countOrZero),
      ]);
    const wrongSectionChildren = slots + queueItems + aduConfigs + slotClaims;
    return {
      dirty: unsectionedDestinations > 0 || wrongSectionChildren > 0,
      unsectionedDestinations,
      wrongSectionChildren,
      checkedAt,
    };
  } catch {
    return { dirty: false, unsectionedDestinations: 0, wrongSectionChildren: 0, checkedAt };
  }
}

export async function probeInternalHealth(
  deps?: InternalHealthDeps
): Promise<{ statusCode: number; payload: InternalHealthPayload }> {
  const now = deps?.now ?? new Date();
  const timestamp = now.toISOString();
  const db = deps?.db ?? getSupabaseAdminClient();

  if (!db) {
    return {
      statusCode: 503,
      payload: {
        status: 'unhealthy',
        timestamp,
        checks: {
          database: { ok: false, latencyMs: null },
          heartbeat: EMPTY_HEARTBEAT,
          queue: EMPTY_QUEUE,
          storage: { ok: false },
          facebook: {
            pagesByStatus: {},
            accountsByStatus: {},
            sectionCheck: {
              dirty: false,
              unsectionedDestinations: 0,
              wrongSectionChildren: 0,
              checkedAt: timestamp,
            },
          },
        },
      },
    };
  }

  // Database + latency
  const dbStart = Date.now();
  let dbOk = false;
  try {
    const { error } = await db
      .from('workspaces')
      .select('id', { head: true, count: 'exact' });
    dbOk = !error;
  } catch {
    dbOk = false;
  }
  const latencyMs = dbOk ? Date.now() - dbStart : null;

  const heartbeat = await checkHeartbeat(db, now);
  const queue = await checkQueue(db, now);

  const storageOk = deps?.checkStorage
    ? await deps.checkStorage()
    : await defaultCheckStorage();

  const [pagesByStatus, accountsByStatus, sectionCheck] = await Promise.all([
    countByStatus(db, 'destinations', PAGE_STATUSES, 'facebook', [
      'schedule',
      'adu',
      'mirror',
      null,
    ]),
    countByStatus(db, 'social_accounts', ACCOUNT_STATUSES, 'facebook'),
    checkSectionIntegrity(db, now),
  ]);

  const unhealthy = !dbOk || !heartbeat.ok || !storageOk;
  let status: InternalHealthPayload['status'] = 'ok';
  if (unhealthy) {
    status = 'unhealthy';
  } else if (queue.stuckPublishingCount > 0 || sectionCheck.dirty) {
    status = 'degraded';
  }

  return {
    statusCode: unhealthy ? 503 : 200,
    payload: {
      status,
      timestamp,
      checks: {
        database: { ok: dbOk, latencyMs },
        heartbeat,
        queue,
        storage: { ok: storageOk },
        facebook: { pagesByStatus, accountsByStatus, sectionCheck },
      },
    },
  };
}

export async function GET(request: Request) {
  if (!(await authorizeInternalRequest(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const result = await probeInternalHealth();
  return NextResponse.json(result.payload, {
    status: result.statusCode,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
