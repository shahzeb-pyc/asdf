/**
 * Daily section check (spec 174 Phase 3B).
 *
 * Every destination row must carry a section label (schedule / adu /
 * mirror / publish_now), and every child row must sit on the row of
 * the section that owns it:
 *
 *   - posting_slots (posting times) live on `schedule` rows only;
 *   - queue_items (queued posts) live on `schedule` or `publish_now`
 *     rows (the Schedule queue and the Publish Now queue);
 *   - adu_configs live on `adu` rows only;
 *   - posting_slot_claims live on `schedule` rows only (a claim is
 *     a Schedule-slot claim; its destination is the claimed slot's).
 *
 * The check is READ-ONLY and counts-only: five exact-count queries,
 * no row contents, no ids, no captions — the same observability rule
 * as the retention job. It never repairs anything (no auto-repair by
 * design): a dirty result is reported loudly and a human fixes it
 * (Phase 4 backfills the stragglers).
 *
 * NULL-section semantics (PostgREST): `neq` on an embedded column
 * never matches a NULL section, so a child sitting on an unlabelled
 * row is NOT counted as wrong-section — the parent row itself is
 * counted by the unsectioned check, which is what raises the dirty
 * flag. The wrong-section counts therefore cover children on
 * labelled rows with the wrong label only.
 *
 * The health route (apps/web/src/app/api/internal/health/route.ts)
 * evaluates the same predicates live for its `sectionCheck` flag,
 * scoped to Facebook (that route's block is Facebook-only); this
 * cron covers every platform.
 */

/** Cron expression for the daily section check (wrangler.toml triggers). */
export const SECTION_CHECK_CRON = '0 4 * * *';

/** Per-check exact counts. Every count is a number of rows. */
export interface SectionCheckCounts {
  /** Destination rows with no section label yet. */
  unsectionedDestinations: number;
  /** Posting slots on a row whose section is not `schedule`. */
  slotsOnWrongSection: number;
  /** Queue items on a row whose section is neither `schedule` nor `publish_now`. */
  queueItemsOnWrongSection: number;
  /** ADU configs on a row whose section is not `adu`. */
  aduConfigsOnWrongSection: number;
  /** Slot claims on a row whose section is not `schedule`. */
  slotClaimsOnWrongSection: number;
}

/** The result of one daily-check run. */
export interface SectionCheckResult extends SectionCheckCounts {
  /** True when any count is non-zero. */
  dirty: boolean;
  /** ISO timestamp the check ran at. */
  checkedAt: string;
}

/** One count-query result from the Supabase-shaped client. */
export interface SectionCheckCountResult {
  count: number | null;
  error: unknown;
}

/**
 * The slice of the Supabase query builder the check uses: head-count
 * selects with `is` / `neq` / `not` filters, awaited directly (the
 * builder is thenable). The production client satisfies this
 * structurally; tests use an in-memory fake with PostgREST-faithful
 * filter semantics for exactly these operators.
 */
export interface SectionCheckQueryBuilder {
  select(
    columns: string,
    options?: { count?: 'exact'; head?: boolean }
  ): SectionCheckQueryBuilder;
  is(column: string, value: unknown): SectionCheckQueryBuilder;
  eq(column: string, value: unknown): SectionCheckQueryBuilder;
  neq(column: string, value: unknown): SectionCheckQueryBuilder;
  not(column: string, operator: string, value: unknown): SectionCheckQueryBuilder;
  then<TResult1 = SectionCheckCountResult, TResult2 = never>(
    onfulfilled?:
      | ((value: SectionCheckCountResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>;
}

/** The slice of the Supabase client the check uses. */
export interface SectionCheckDbClient {
  from(table: string): SectionCheckQueryBuilder;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'unknown error';
}

async function countRows(
  db: SectionCheckDbClient,
  table: string,
  build: (query: SectionCheckQueryBuilder) => SectionCheckQueryBuilder
): Promise<number> {
  const { count, error } = await build(
    db.from(table).select('id', { count: 'exact', head: true })
  );
  if (error) {
    throw new Error(`section check failed: table=${table} error=${errorMessage(error)}`);
  }
  return count ?? 0;
}

async function countChildRows(
  db: SectionCheckDbClient,
  table: string,
  build: (query: SectionCheckQueryBuilder) => SectionCheckQueryBuilder
): Promise<number> {
  const { count, error } = await build(
    db
      .from(table)
      .select('id, destinations!inner(section)', { count: 'exact', head: true })
  );
  if (error) {
    throw new Error(`section check failed: table=${table} error=${errorMessage(error)}`);
  }
  return count ?? 0;
}

/**
 * Run the daily section check. Throws on any query failure (fail
 * loud — the cron handler captures and rethrows, so a broken check
 * never reports a silent clean). Returns counts + dirty flag.
 */
export async function runSectionCheck(
  db: SectionCheckDbClient,
  now: Date = new Date()
): Promise<SectionCheckResult> {
  const [unsectionedDestinations, slotsOnWrongSection, queueItemsOnWrongSection, aduConfigsOnWrongSection, slotClaimsOnWrongSection] =
    await Promise.all([
      countRows(db, 'destinations', (q) => q.is('section', null)),
      countChildRows(db, 'posting_slots', (q) =>
        q.neq('destinations.section', 'schedule')
      ),
      countChildRows(db, 'queue_items', (q) =>
        q.not('destinations.section', 'in', '(schedule,publish_now)')
      ),
      countChildRows(db, 'adu_configs', (q) => q.neq('destinations.section', 'adu')),
      countChildRows(db, 'posting_slot_claims', (q) =>
        q.neq('destinations.section', 'schedule')
      ),
    ]);
  const dirty =
    unsectionedDestinations > 0 ||
    slotsOnWrongSection > 0 ||
    queueItemsOnWrongSection > 0 ||
    aduConfigsOnWrongSection > 0 ||
    slotClaimsOnWrongSection > 0;
  return {
    unsectionedDestinations,
    slotsOnWrongSection,
    queueItemsOnWrongSection,
    aduConfigsOnWrongSection,
    slotClaimsOnWrongSection,
    dirty,
    checkedAt: now.toISOString(),
  };
}
