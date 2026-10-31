import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * Backfill script coverage (PR #74 Sonar gate): the script is a
 * standalone node program, so Sonar counts its 112 executable lines
 * as new code at 0% unless a suite actually runs it. These tests
 * import the module (its top-level run is guarded to direct
 * execution only) and drive its exported main() against fakes for
 * Supabase (PostgREST-shaped) and S3, asserting on the real
 * outcomes: the printed report, the S3 commands issued, and the
 * Supabase updates issued. Nothing here stubs the script's own
 * logic — classification, key building, paging, and the
 * concurrent-change cleanup all execute for real.
 */

class ProcessExit extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

interface QueryResult {
  data: unknown[] | null;
  error: { message: string } | null;
}

const harness = vi.hoisted(() => {
  const state = {
    queuePages: [] as QueryResult[],
    mediaResult: { data: [] as unknown[], error: null } as QueryResult,
    updateResults: [] as QueryResult[],
    s3Impl: null as null | ((cmd: { input: Record<string, unknown> }) => Promise<unknown>),
    s3Calls: [] as Array<{ input: Record<string, unknown> }>,
    updatePatches: [] as unknown[],
  };

  class FakeCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }

  class FakeBuilder {
    table: string;
    isUpdate = false;
    updatePatch: unknown = null;
    constructor(table: string) {
      this.table = table;
    }
    select(): this {
      return this;
    }
    eq(): this {
      return this;
    }
    in(): this {
      return this;
    }
    order(): this {
      return this;
    }
    range(): this {
      return this;
    }
    update(patch: unknown): this {
      this.isUpdate = true;
      this.updatePatch = patch;
      return this;
    }
    then(
      resolve: (value: QueryResult) => unknown,
      reject: (reason: unknown) => unknown
    ): Promise<unknown> {
      let result: QueryResult;
      if (this.isUpdate) {
        state.updatePatches.push(this.updatePatch);
        result = state.updateResults.shift() ?? { data: [], error: null };
      } else if (this.table === 'queue_items') {
        result = state.queuePages.shift() ?? { data: [], error: null };
      } else {
        result = state.mediaResult;
      }
      return Promise.resolve(result).then(resolve, reject);
    }
  }

  class FakeSupabaseClient {
    from(table: string): FakeBuilder {
      return new FakeBuilder(table);
    }
  }

  class FakeS3Client {
    async send(cmd: { input: Record<string, unknown> }): Promise<unknown> {
      state.s3Calls.push(cmd);
      if (state.s3Impl) return state.s3Impl(cmd);
      return {};
    }
  }

  return { state, FakeCommand, FakeSupabaseClient, FakeS3Client };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: harness.FakeS3Client,
  CopyObjectCommand: harness.FakeCommand,
  DeleteObjectCommand: harness.FakeCommand,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => new harness.FakeSupabaseClient(),
}));

const ENV_VARS = {
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'ak',
  R2_SECRET_ACCESS_KEY: 'sk',
  R2_BUCKET_NAME: 'bucket',
  R2_PUBLIC_URL: 'https://media.example.com///',
};

type Row = {
  id: string;
  media_item_id: string | null;
  media_storage_key: string | null;
};

function row(
  id: string,
  mediaItemId: string | null,
  mediaStorageKey: string | null
): Row {
  return { id, media_item_id: mediaItemId, media_storage_key: mediaStorageKey };
}

/** Load a fresh copy of the script module with the given CLI args. */
async function loadMain(argv: string[]): Promise<() => Promise<void>> {
  const savedArgv = process.argv;
  process.argv = ['node', '/fake/backfill-post-owned-media.mjs', ...argv];
  try {
    vi.resetModules();
    const mod = await import('../scripts/backfill-post-owned-media.mjs');
    return mod.main as () => Promise<void>;
  } finally {
    process.argv = savedArgv;
  }
}

function reportFromLogs(logs: string[]): Record<string, unknown> {
  const json = logs.find((line) => line.startsWith('{'));
  expect(json).toBeDefined();
  return JSON.parse(json as string) as Record<string, unknown>;
}

describe('backfill-post-owned-media script', () => {
  const originalEnv = process.env;
  let logs: string[] = [];
  let errors: string[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv, ...ENV_VARS };
    harness.state.queuePages = [];
    harness.state.mediaResult = { data: [], error: null };
    harness.state.updateResults = [];
    harness.state.s3Impl = null;
    harness.state.s3Calls = [];
    harness.state.updatePatches = [];
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExit(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('dry run triages every row kind and writes nothing', async () => {
    harness.state.queuePages = [
      {
        data: [
          row('r1', null, 'users/x/media/1/photo.jpg'),
          row('r2', 'm2', null),
          row('r3', 'm3', ''),
          row('r4', 'm4', 'users/u1/post-media/uuid/photo.jpg'),
          row('r5', 'm5', 'users/orig/media/1/My Photo (1).jpg'),
          row('r6', 'm6', 'users/u6/media/1/pic.png'),
          row('r7', 'm7', 'other-bucket/media/1/pic.png'),
        ],
        error: null,
      },
    ];
    harness.state.mediaResult = {
      data: [
        { id: 'm4', user_id: 'u1' },
        { id: 'm5', user_id: 'u5' },
      ],
      error: null,
    };

    const main = await loadMain(['--dry-run']);
    await main();

    const report = reportFromLogs(logs);
    expect(report.examined).toBe(7);
    expect(report.skipped).toBe(1);
    expect(report.unlinkedOnly).toBe(1);
    expect(report.copied).toBe(2);
    expect(report.failed).toEqual([]);
    expect(report.changedConcurrently).toEqual([]);
    const unrecoverable = report.unrecoverable as Array<{ id: string }>;
    expect(unrecoverable.map((r) => r.id).sort()).toEqual(['r2', 'r3', 'r7']);
    // Dry run: no S3 copies, no row updates, despite copy/unlink rows.
    expect(harness.state.s3Calls).toHaveLength(0);
    expect(harness.state.updatePatches).toHaveLength(0);
    expect(logs.some((l) => l.includes('UNRECOVERABLE rows'))).toBe(true);
    expect(logs.some((l) => l.includes('Dry run complete'))).toBe(true);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('dry run with an empty first page reports zero rows', async () => {
    harness.state.queuePages = [{ data: [], error: null }];
    const main = await loadMain(['--dry-run']);
    await main();
    const report = reportFromLogs(logs);
    expect(report.examined).toBe(0);
    expect(report.copied).toBe(0);
  });

  it('pages past a full 500-row page (null second page ends the scan)', async () => {
    const page = Array.from({ length: 500 }, (_, i) => row(`r${i}`, null, 'x'));
    harness.state.queuePages = [
      { data: page, error: null },
      { data: null, error: null },
    ];
    const main = await loadMain(['--dry-run']);
    await main();
    const report = reportFromLogs(logs);
    expect(report.examined).toBe(500);
    expect(report.skipped).toBe(500);
  });

  it('resolves the owner from the users/ prefix when no library row exists', async () => {
    harness.state.queuePages = [
      { data: [row('r6', 'm6', 'users/u6/media/1/pic.png')], error: null },
    ];
    harness.state.mediaResult = { data: null, error: null };
    const main = await loadMain(['--dry-run']);
    await main();
    const report = reportFromLogs(logs);
    expect(report.copied).toBe(1);
    expect(report.unrecoverable).toEqual([]);
  });

  it('exits 2 when a required environment variable is missing', async () => {
    delete process.env.SUPABASE_URL;
    const main = await loadMain(['--dry-run']);
    await expect(main()).rejects.toMatchObject({ code: 2 });
    expect(errors.some((e) => e.includes('SUPABASE_URL'))).toBe(true);
  });

  it('exits 1 when paging queue_items fails', async () => {
    harness.state.queuePages = [{ data: null, error: { message: 'page boom' } }];
    const main = await loadMain(['--dry-run']);
    await expect(main()).rejects.toMatchObject({ code: 1 });
    expect(errors.some((e) => e.includes('Failed to page queue_items'))).toBe(true);
  });

  it('exits 1 when resolving media owners fails', async () => {
    harness.state.queuePages = [
      { data: [row('r5', 'm5', 'users/orig/media/1/pic.png')], error: null },
    ];
    harness.state.mediaResult = { data: null, error: { message: 'owners boom' } };
    const main = await loadMain(['--dry-run']);
    await expect(main()).rejects.toMatchObject({ code: 1 });
    expect(errors.some((e) => e.includes('Failed to resolve media owners'))).toBe(true);
  });

  it('apply copies bytes, then updates the row to the post-owned key', async () => {
    harness.state.queuePages = [
      { data: [row('r5', 'm5', 'users/orig/media/1/My Photo (1).jpg')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm5', user_id: 'u5' }], error: null };
    harness.state.updateResults = [{ data: [{ id: 'r5' }], error: null }];

    const main = await loadMain(['--apply']);
    await main();

    const report = reportFromLogs(logs);
    expect(report.copied).toBe(1);
    expect(harness.state.s3Calls).toHaveLength(1);
    const copy = harness.state.s3Calls[0].input;
    expect(copy.Bucket).toBe('bucket');
    // Segments URL-encoded, slashes literal — encoding slashes breaks R2 copies.
    // (encodeURIComponent leaves parentheses unencoded; space is encoded.)
    expect(copy.CopySource).toBe('bucket/users/orig/media/1/My%20Photo%20(1).jpg');
    expect(copy.Key).toMatch(/^users\/u5\/post-media\/[^/]+\/My_Photo__1_\.jpg$/);
    expect(harness.state.updatePatches).toHaveLength(1);
    const patch = harness.state.updatePatches[0] as Record<string, unknown>;
    expect(patch.media_item_id).toBeNull();
    expect(patch.media_storage_key).toBe(copy.Key);
    // Public base had trailing slashes; the URL joins with exactly one.
    expect(patch.media_url).toBe(`https://media.example.com/${copy.Key as string}`);
    expect(logs.some((l) => l.includes('Backfill complete.'))).toBe(true);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('apply unlinks an already post-owned row without copying', async () => {
    harness.state.queuePages = [
      { data: [row('r4', 'm4', 'users/u1/post-media/uuid/photo.jpg')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm4', user_id: 'u1' }], error: null };
    harness.state.updateResults = [{ data: [{ id: 'r4' }], error: null }];

    const main = await loadMain(['--apply']);
    await main();

    const report = reportFromLogs(logs);
    expect(report.unlinkedOnly).toBe(1);
    expect(harness.state.s3Calls).toHaveLength(0);
    expect(harness.state.updatePatches).toEqual([{ media_item_id: null }]);
  });

  it('apply deletes the just-made copy when the row changed concurrently', async () => {
    harness.state.queuePages = [
      { data: [row('r5', 'm5', 'users/orig/media/1/pic.png')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm5', user_id: 'u5' }], error: null };
    // Update affects 0 rows: the row changed under the script.
    harness.state.updateResults = [{ data: [], error: null }];

    const main = await loadMain(['--apply']);
    await main();

    const report = reportFromLogs(logs);
    expect(report.changedConcurrently).toEqual(['r5']);
    expect(report.copied).toBe(0);
    expect(harness.state.s3Calls).toHaveLength(2);
    const copyKey = harness.state.s3Calls[0].input.Key;
    expect(harness.state.s3Calls[1].input).toEqual({ Bucket: 'bucket', Key: copyKey });
  });

  it('apply reports a concurrently-changed unlink without failing', async () => {
    harness.state.queuePages = [
      { data: [row('r4', 'm4', 'users/u1/post-media/uuid/photo.jpg')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm4', user_id: 'u1' }], error: null };
    harness.state.updateResults = [{ data: [], error: null }];

    const main = await loadMain(['--apply']);
    await main();

    const report = reportFromLogs(logs);
    expect(report.changedConcurrently).toEqual(['r4']);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('apply treats gone source bytes as unrecoverable, not failed', async () => {
    harness.state.queuePages = [
      { data: [row('r5', 'm5', 'users/orig/media/1/pic.png')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm5', user_id: 'u5' }], error: null };
    harness.state.s3Impl = async () => {
      throw new Error('NoSuchKey: the specified key does not exist');
    };

    const main = await loadMain(['--apply']);
    await main();

    const report = reportFromLogs(logs);
    expect(report.failed).toEqual([]);
    const unrecoverable = report.unrecoverable as Array<{ id: string; reason: string }>;
    expect(unrecoverable).toHaveLength(1);
    expect(unrecoverable[0].reason).toContain('source bytes already gone');
    expect(harness.state.updatePatches).toHaveLength(0);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('apply marks other copy errors failed and exits 1', async () => {
    harness.state.queuePages = [
      { data: [row('r5', 'm5', 'users/orig/media/1/pic.png')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm5', user_id: 'u5' }], error: null };
    harness.state.s3Impl = async () => {
      throw new Error('network down');
    };

    const main = await loadMain(['--apply']);
    await expect(main()).rejects.toMatchObject({ code: 1 });
    const report = reportFromLogs(logs);
    const failed = report.failed as Array<{ id: string; error: string }>;
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe('network down');
    expect(logs.some((l) => l.includes('FAILED rows'))).toBe(true);
  });

  it('apply stringifies a non-Error copy failure', async () => {
    harness.state.queuePages = [
      { data: [row('r5', 'm5', 'users/orig/media/1/pic.png')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm5', user_id: 'u5' }], error: null };
    harness.state.s3Impl = async () => {
      throw 'plain string failure';
    };

    const main = await loadMain(['--apply']);
    await expect(main()).rejects.toMatchObject({ code: 1 });
    const report = reportFromLogs(logs);
    const failed = report.failed as Array<{ error: string }>;
    expect(failed[0].error).toBe('plain string failure');
  });

  it('apply marks a failed unlink-only update failed and exits 1', async () => {
    harness.state.queuePages = [
      { data: [row('r4', 'm4', 'users/u1/post-media/uuid/photo.jpg')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm4', user_id: 'u1' }], error: null };
    harness.state.updateResults = [{ data: null, error: { message: 'unlink db down' } }];

    const main = await loadMain(['--apply']);
    await expect(main()).rejects.toMatchObject({ code: 1 });
    const report = reportFromLogs(logs);
    const failed = report.failed as Array<{ error: string }>;
    expect(failed[0].error).toBe('unlink db down');
  });

  it('apply marks a failed row update failed and exits 1', async () => {
    harness.state.queuePages = [
      { data: [row('r5', 'm5', 'users/orig/media/1/pic.png')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm5', user_id: 'u5' }], error: null };
    harness.state.updateResults = [{ data: null, error: { message: 'db down' } }];

    const main = await loadMain(['--apply']);
    await expect(main()).rejects.toMatchObject({ code: 1 });
    const report = reportFromLogs(logs);
    const failed = report.failed as Array<{ error: string }>;
    expect(failed[0].error).toBe('db down');
  });

  it('apply reports a failed concurrent-change cleanup instead of crashing', async () => {
    harness.state.queuePages = [
      { data: [row('r5', 'm5', 'users/orig/media/1/pic.png')], error: null },
    ];
    harness.state.mediaResult = { data: [{ id: 'm5', user_id: 'u5' }], error: null };
    harness.state.updateResults = [{ data: [], error: null }];
    let calls = 0;
    harness.state.s3Impl = async () => {
      calls += 1;
      if (calls === 2) throw new Error('delete refused');
      return {};
    };

    const main = await loadMain(['--apply']);
    await main();

    const report = reportFromLogs(logs);
    expect(report.changedConcurrently).toEqual(['r5']);
    expect(errors.some((e) => e.includes('could not be cleaned up'))).toBe(true);
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('apply sanitises basenames that would otherwise be hidden or empty', async () => {
    harness.state.queuePages = [
      {
        data: [
          row('ra', 'ma', 'users/orig/media/1/.hidden'),
          row('rb', 'mb', 'users/orig/media/1/'),
        ],
        error: null,
      },
    ];
    harness.state.mediaResult = {
      data: [
        { id: 'ma', user_id: 'u5' },
        { id: 'mb', user_id: 'u5' },
      ],
      error: null,
    };
    harness.state.updateResults = [
      { data: [{ id: 'ra' }], error: null },
      { data: [{ id: 'rb' }], error: null },
    ];

    const main = await loadMain(['--apply']);
    await main();

    const report = reportFromLogs(logs);
    expect(report.copied).toBe(2);
    for (const call of harness.state.s3Calls) {
      expect(call.input.Key as string).toMatch(/\/file$/);
    }
  });
});
