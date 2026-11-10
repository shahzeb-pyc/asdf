/**
 * S3 — resolveWorkspaceIdFromSession (spec s3-workspace-id-in-session).
 *
 * The claim path must return the token's workspace id with ZERO
 * database lookups; every other shape (old claimless token, mismatched
 * subdomain, non-user role, admin callers) falls back to the same
 * owner-checked DB lookup as today. The A17 measurement (three
 * numbers) is pinned in the test below, not asserted loosely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SessionPayload } from '@fbuploadpro/contracts';
import {
  resolveTenantWorkspaceId,
  resolveWorkspaceIdFromSession,
} from './workspace-resolver';

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type WorkspaceRow = { id: string; subdomain: string; owner_id: string };

/** Chainable Supabase query-builder fake with a lookup counter. */
class FakeQuery {
  private readonly filters: Array<[string, unknown]> = [];

  public constructor(
    private readonly rows: WorkspaceRow[],
    private readonly counter: { lookups: number },
    private readonly fail?: boolean
  ) {}

  public select(): this {
    return this;
  }

  public eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  public async maybeSingle(): Promise<{ data: WorkspaceRow | null; error: unknown }> {
    this.counter.lookups += 1;
    if (this.fail) {
      throw new Error('forced DB error');
    }
    const match =
      this.rows.find((row) =>
        this.filters.every(([column, value]) => (row as Record<string, unknown>)[column] === value)
      ) ?? null;
    return { data: match, error: null };
  }
}

class FakeSupabase {
  public constructor(
    private readonly rows: WorkspaceRow[],
    public readonly counter: { lookups: number },
    private readonly fail?: boolean
  ) {}

  public from(): FakeQuery {
    return new FakeQuery(this.rows, this.counter, this.fail);
  }
}

/** Legacy SQL client fake with a query counter. */
class FakeLegacyClient {
  public queries = 0;

  public constructor(private readonly rows: WorkspaceRow[]) {}

  public async query(sql: string, params: unknown[]): Promise<Array<{ id: string }>> {
    this.queries += 1;
    const [subdomain, ownerId] = params as [string, string?];
    const match = this.rows.find(
      (row) =>
        row.subdomain === subdomain && (ownerId === undefined || row.owner_id === ownerId)
    );
    return match ? [{ id: match.id }] : [];
  }
}

const USER_ID = '11111111-1111-4111-a111-111111111111';
const WORKSPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_USER = '22222222-2222-4222-a222-222222222222';

const ROWS: WorkspaceRow[] = [
  { id: WORKSPACE_A, subdomain: 'acme', owner_id: USER_ID },
  { id: WORKSPACE_B, subdomain: 'acme-two', owner_id: USER_ID },
  { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', subdomain: 'other', owner_id: OTHER_USER },
];

function makeSession(overrides: Partial<SessionPayload> = {}): SessionPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    userId: USER_ID,
    email: 'client@gmail.com',
    name: 'Acme Client',
    subdomain: 'acme',
    role: 'user',
    status: 'active',
    iat: now,
    exp: now + 86400,
    ...overrides,
  };
}

describe('resolveWorkspaceIdFromSession (S3)', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('A12: a matching claim returns the id with zero workspace lookups', async () => {
    const counter = { lookups: 0 };
    const client = new FakeSupabase(ROWS, counter);
    const id = await resolveWorkspaceIdFromSession(
      makeSession({ workspaceId: WORKSPACE_A }),
      'acme',
      client as never
    );
    expect(id).toBe(WORKSPACE_A);
    expect(counter.lookups).toBe(0);
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('A12: the claim match is case-insensitive, like canAccessTenant', async () => {
    const counter = { lookups: 0 };
    const client = new FakeSupabase(ROWS, counter);
    const id = await resolveWorkspaceIdFromSession(
      makeSession({ workspaceId: WORKSPACE_A }),
      'ACME',
      client as never
    );
    expect(id).toBe(WORKSPACE_A);
    expect(counter.lookups).toBe(0);
  });

  it('A11/A17: an old claimless token falls back to exactly one DB lookup', async () => {
    const counter = { lookups: 0 };
    const client = new FakeSupabase(ROWS, counter);
    const id = await resolveWorkspaceIdFromSession(makeSession(), 'acme', client as never);
    expect(id).toBe(WORKSPACE_A);
    expect(counter.lookups).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(
      '[workspace-resolver] workspace-id fallback used',
      expect.objectContaining({ reason: 'no-claim' })
    );
  });

  it('A13/A15: a mismatched subdomain falls back and resolves the requested workspace', async () => {
    const counter = { lookups: 0 };
    const client = new FakeSupabase(ROWS, counter);
    const id = await resolveWorkspaceIdFromSession(
      makeSession({ workspaceId: WORKSPACE_A, allowedSubdomains: ['acme', 'acme-two'] }),
      'acme-two',
      client as never
    );
    expect(id).toBe(WORKSPACE_B);
    expect(counter.lookups).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(
      '[workspace-resolver] workspace-id fallback used',
      expect.objectContaining({ reason: 'subdomain-mismatch' })
    );
  });

  it('A13: a subdomain the user does not own answers null, never the claimed id', async () => {
    const counter = { lookups: 0 };
    const client = new FakeSupabase(ROWS, counter);
    const id = await resolveWorkspaceIdFromSession(
      makeSession({ workspaceId: WORKSPACE_A }),
      'other',
      client as never
    );
    expect(id).toBeNull();
    expect(counter.lookups).toBe(1);
  });

  it('A14: an admin token (even with a stale claim) falls back and resolves any owner when the site passes role', async () => {
    const counter = { lookups: 0 };
    const client = new FakeSupabase(ROWS, counter);
    const admin = makeSession({
      userId: '33333333-3333-4333-a333-333333333333',
      subdomain: 'platform-admin',
      role: 'admin',
      workspaceId: WORKSPACE_A,
    });
    const id = await resolveWorkspaceIdFromSession(admin, 'other', client as never, 'admin');
    expect(id).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(counter.lookups).toBe(1);
    expect(infoSpy).toHaveBeenCalledWith(
      '[workspace-resolver] workspace-id fallback used',
      expect.objectContaining({ reason: 'role-not-user' })
    );
  });

  it('A14: an admin token on a site that passes no role still resolves as a non-owner (null)', async () => {
    const counter = { lookups: 0 };
    const client = new FakeSupabase(ROWS, counter);
    const admin = makeSession({
      userId: '33333333-3333-4333-a333-333333333333',
      subdomain: 'platform-admin',
      role: 'admin',
    });
    const id = await resolveWorkspaceIdFromSession(admin, 'other', client as never);
    expect(id).toBeNull();
    expect(counter.lookups).toBe(1);
  });

  it('A17: before = 1 lookup, after with claim = 0, after with old token = 1', async () => {
    // "Before" is the unchanged resolver: one workspace lookup per call.
    const beforeCounter = { lookups: 0 };
    const beforeClient = new FakeSupabase(ROWS, beforeCounter);
    const before = await resolveTenantWorkspaceId(beforeClient as never, 'acme', USER_ID);
    expect(before).toBe(WORKSPACE_A);
    expect(beforeCounter.lookups).toBe(1);

    // "After, new token": the claim skips the lookup entirely.
    const claimCounter = { lookups: 0 };
    const claimClient = new FakeSupabase(ROWS, claimCounter);
    const withClaim = await resolveWorkspaceIdFromSession(
      makeSession({ workspaceId: WORKSPACE_A }),
      'acme',
      claimClient as never
    );
    expect(withClaim).toBe(WORKSPACE_A);
    expect(claimCounter.lookups).toBe(0);

    // "After, old token": the fallback still pays exactly one lookup.
    const oldCounter = { lookups: 0 };
    const oldClient = new FakeSupabase(ROWS, oldCounter);
    const oldToken = await resolveWorkspaceIdFromSession(
      makeSession(),
      'acme',
      oldClient as never
    );
    expect(oldToken).toBe(WORKSPACE_A);
    expect(oldCounter.lookups).toBe(1);
  });

  it('a DB error on the fallback path still returns null (spec 139 B19 behaviour kept)', async () => {
    const counter = { lookups: 0 };
    const client = new FakeSupabase(ROWS, counter, true);
    const id = await resolveWorkspaceIdFromSession(makeSession(), 'acme', client as never);
    expect(id).toBeNull();
    expect(counter.lookups).toBe(1);
  });

  it('legacy SQL client: claim hit pays zero queries, fallback pays one', async () => {
    const legacy = new FakeLegacyClient(ROWS);
    const withClaim = await resolveWorkspaceIdFromSession(
      makeSession({ workspaceId: WORKSPACE_A }),
      'acme',
      legacy as never
    );
    expect(withClaim).toBe(WORKSPACE_A);
    expect(legacy.queries).toBe(0);

    const withoutClaim = await resolveWorkspaceIdFromSession(makeSession(), 'acme', legacy as never);
    expect(withoutClaim).toBe(WORKSPACE_A);
    expect(legacy.queries).toBe(1);
  });
});
