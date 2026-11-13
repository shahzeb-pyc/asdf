/**
 * Daily section check — unit tests (spec 174 Phase 3B).
 *
 * The fake DbClient below is PostgREST-faithful for exactly the
 * operators the check uses (`is`, `neq`, `not ... in`), including
 * the NULL semantics that matter here: `neq` never matches a NULL
 * section, so a child on an unlabelled row is counted by the
 * unsectioned check, not the wrong-section check.
 */
import { describe, expect, it } from 'vitest';
import {
  runSectionCheck,
  type SectionCheckDbClient,
  type SectionCheckQueryBuilder,
} from './section-check.js';

type DestinationRow = { id: string; section: string | null };
type ChildRow = { id: string; destination_id: string };

interface FakeStore {
  destinations: DestinationRow[];
  posting_slots: ChildRow[];
  queue_items: ChildRow[];
  adu_configs: ChildRow[];
  posting_slot_claims: ChildRow[];
  failTables?: Set<string>;
}

type Filter =
  | { kind: 'is'; column: string; value: unknown }
  | { kind: 'eq'; column: string; value: unknown }
  | { kind: 'neq'; column: string; value: unknown }
  | { kind: 'not'; column: string; operator: string; value: unknown };

function createFakeDb(store: FakeStore): SectionCheckDbClient {
  const from = (table: string): SectionCheckQueryBuilder => {
    const filters: Filter[] = [];
    let columns = '';
    const builder = {
      select(cols: string) {
        columns = cols;
        return builder;
      },
      is(column: string, value: unknown) {
        filters.push({ kind: 'is', column, value });
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push({ kind: 'eq', column, value });
        return builder;
      },
      neq(column: string, value: unknown) {
        filters.push({ kind: 'neq', column, value });
        return builder;
      },
      not(column: string, operator: string, value: unknown) {
        filters.push({ kind: 'not', column, operator, value });
        return builder;
      },
      then<TResult1 = { count: number | null; error: unknown }, TResult2 = never>(
        onfulfilled?:
          | ((
              value: { count: number | null; error: unknown }
            ) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
      ): PromiseLike<TResult1 | TResult2> {
        const promise: Promise<{ count: number | null; error: unknown }> = (async () => {
          if (store.failTables?.has(table)) {
            return { count: null, error: new Error(`fake boom on ${table}`) };
          }
          const rows = (
            store as unknown as Record<string, Array<DestinationRow | ChildRow>>
          )[table] as Array<DestinationRow | ChildRow>;
          const joined = table === 'destinations';
          const count = rows.filter((row) => {
            for (const filter of filters) {
              if (joined) {
                const value = (row as DestinationRow)[
                  filter.column as keyof DestinationRow
                ];
                if (filter.kind === 'is') {
                  if (filter.value === null ? value !== null : value !== filter.value)
                    return false;
                } else if (filter.kind === 'eq') {
                  if (value !== filter.value) return false;
                } else if (filter.kind === 'neq') {
                  if (value === null || value === filter.value) return false;
                } else {
                  // 'not' — the last remaining kind.
                  if (filter.operator === 'in' && typeof filter.value === 'string') {
                    const set = filter.value.slice(1, -1).split(',');
                    if (value === null || set.includes(String(value))) return false;
                  }
                }
              } else {
                // Child table with a `destinations!inner(section)`
                // embed: resolve the parent row; `!inner` drops
                // rows with no parent (none in these fixtures).
                if (!columns.includes('destinations!inner')) return false;
                const dest = store.destinations.find(
                  (d) => d.id === (row as ChildRow).destination_id
                );
                if (!dest) return false;
                const section = dest.section;
                if (filter.kind === 'neq') {
                  if (section === null || section === filter.value) return false;
                } else if (filter.kind === 'not') {
                  if (filter.operator === 'in' && typeof filter.value === 'string') {
                    const set = filter.value.slice(1, -1).split(',');
                    if (section === null || set.includes(section)) return false;
                  }
                } else if (filter.kind === 'eq') {
                  if (section !== filter.value) return false;
                } else {
                  // 'is' — the last remaining kind.
                  if (filter.value === null ? section !== null : section !== filter.value)
                    return false;
                }
              }
            }
            return true;
          }).length;
          return { count, error: null };
        })();
        return promise.then(onfulfilled as never, onrejected as never);
      },
    } as unknown as SectionCheckQueryBuilder;
    return builder;
  };
  return { from } as SectionCheckDbClient;
}

function cleanStore(): FakeStore {
  return {
    destinations: [
      { id: 'd-schedule', section: 'schedule' },
      { id: 'd-adu', section: 'adu' },
      { id: 'd-mirror', section: 'mirror' },
      { id: 'd-pn', section: 'publish_now' },
    ],
    posting_slots: [{ id: 's1', destination_id: 'd-schedule' }],
    queue_items: [
      { id: 'q1', destination_id: 'd-schedule' },
      { id: 'q2', destination_id: 'd-pn' },
    ],
    adu_configs: [{ id: 'a1', destination_id: 'd-adu' }],
    posting_slot_claims: [{ id: 'c1', destination_id: 'd-schedule' }],
  };
}

describe('runSectionCheck', () => {
  it('reports clean on a fully labelled store', async () => {
    const result = await runSectionCheck(createFakeDb(cleanStore()));
    expect(result).toEqual({
      unsectionedDestinations: 0,
      slotsOnWrongSection: 0,
      queueItemsOnWrongSection: 0,
      aduConfigsOnWrongSection: 0,
      slotClaimsOnWrongSection: 0,
      dirty: false,
      checkedAt: expect.any(String),
    });
  });

  it('flags a seeded labelless destination row', async () => {
    const store = cleanStore();
    store.destinations.push({ id: 'd-none', section: null });
    const result = await runSectionCheck(createFakeDb(store));
    expect(result.unsectionedDestinations).toBe(1);
    expect(result.dirty).toBe(true);
  });

  it('flags a posting slot on a non-schedule row', async () => {
    const store = cleanStore();
    store.posting_slots.push({ id: 's2', destination_id: 'd-adu' });
    const result = await runSectionCheck(createFakeDb(store));
    expect(result.slotsOnWrongSection).toBe(1);
    expect(result.dirty).toBe(true);
  });

  it('flags queue items on adu/mirror rows but not schedule or publish_now rows', async () => {
    const store = cleanStore();
    store.queue_items.push(
      { id: 'q3', destination_id: 'd-adu' },
      { id: 'q4', destination_id: 'd-mirror' },
      { id: 'q5', destination_id: 'd-schedule' },
      { id: 'q6', destination_id: 'd-pn' }
    );
    const result = await runSectionCheck(createFakeDb(store));
    expect(result.queueItemsOnWrongSection).toBe(2);
    expect(result.dirty).toBe(true);
  });

  it('flags an ADU config on a schedule row', async () => {
    const store = cleanStore();
    store.adu_configs.push({ id: 'a2', destination_id: 'd-schedule' });
    const result = await runSectionCheck(createFakeDb(store));
    expect(result.aduConfigsOnWrongSection).toBe(1);
    expect(result.dirty).toBe(true);
  });

  it('flags a slot claim on a mirror row', async () => {
    const store = cleanStore();
    store.posting_slot_claims.push({ id: 'c2', destination_id: 'd-mirror' });
    const result = await runSectionCheck(createFakeDb(store));
    expect(result.slotClaimsOnWrongSection).toBe(1);
    expect(result.dirty).toBe(true);
  });

  it('counts a child on an unlabelled row under unsectioned, not wrong-section (PostgREST NULL semantics)', async () => {
    const store = cleanStore();
    store.destinations.push({ id: 'd-none', section: null });
    store.posting_slots.push({ id: 's2', destination_id: 'd-none' });
    store.queue_items.push({ id: 'q3', destination_id: 'd-none' });
    const result = await runSectionCheck(createFakeDb(store));
    expect(result.unsectionedDestinations).toBe(1);
    expect(result.slotsOnWrongSection).toBe(0);
    expect(result.queueItemsOnWrongSection).toBe(0);
    // The parent row still raises the flag.
    expect(result.dirty).toBe(true);
  });

  it('counts every dirty class at once', async () => {
    const store = cleanStore();
    store.destinations.push({ id: 'd-none', section: null });
    store.posting_slots.push({ id: 's2', destination_id: 'd-adu' });
    store.queue_items.push({ id: 'q3', destination_id: 'd-mirror' });
    store.adu_configs.push({ id: 'a2', destination_id: 'd-schedule' });
    store.posting_slot_claims.push({ id: 'c2', destination_id: 'd-adu' });
    const result = await runSectionCheck(createFakeDb(store));
    expect(result).toMatchObject({
      unsectionedDestinations: 1,
      slotsOnWrongSection: 1,
      queueItemsOnWrongSection: 1,
      aduConfigsOnWrongSection: 1,
      slotClaimsOnWrongSection: 1,
      dirty: true,
    });
  });

  it('fails loud when any count query errors', async () => {
    const store = cleanStore();
    store.failTables = new Set(['adu_configs']);
    await expect(runSectionCheck(createFakeDb(store))).rejects.toThrow(
      'section check failed: table=adu_configs'
    );
  });

  it('fails loud when the destinations query errors', async () => {
    const store = cleanStore();
    store.failTables = new Set(['destinations']);
    await expect(runSectionCheck(createFakeDb(store))).rejects.toThrow(
      'section check failed: table=destinations'
    );
  });
});
