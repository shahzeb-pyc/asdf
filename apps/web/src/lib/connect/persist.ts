/**
 * Connect-flow persistence (Spec 123, Part C).
 *
 * Writes only `social_accounts` and `destinations` (spec 120 unified
 * schema). Tokens are encrypted with encryptToken before they touch the
 * database. Reconnecting the same platform account re-binds the existing
 * row: the upsert keys on UNIQUE(workspace_id, platform,
 * external_account_id), so a reconnect never creates a duplicate account.
 *
 * `platform_credentials` is only ever READ here (to resolve a BYOC
 * workspace's client ID/secret for the code exchange). Writes to that table
 * belong to the settings credentials service (spec 123 Part A).
 */
import {
  decryptToken,
  destinationAccountTypeFromMetadata,
  encryptToken,
  getTokenEncryptionKey,
  type DatabaseClient,
  type Platform,
} from '@fbuploadpro/contracts';
import { getRouteSupabase, isLegacyClient } from '@/lib/route-auth';
import type { SupabaseClient } from '@supabase/supabase-js';
import { propagateRevokedAccount } from '@/lib/publishing/account-expiry-propagation';
import type {
  DiscoveredDestination,
  ExchangedAccount,
} from './registry';

export type ConnectDbClient = DatabaseClient | SupabaseClient;

/** Rows always carry a platform; this only guards malformed legacy data. */
const FALLBACK_PLATFORM: Platform = 'facebook';

/** Default status for freshly persisted accounts and destinations. */
const STATUS_ACTIVE = 'active';

export interface SocialDestinationView {
  id: string;
  externalDestinationId: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  timezone: string;
  status: string;
  /**
   * The provider-reported account type from `destinations.metadata`
   * (`account_type`), e.g. Instagram's 'BUSINESS' / 'MEDIA_CREATOR'.
   * Null when the destination's connect never persisted one (every
   * destination connected before the type was recorded) — unknown,
   * never guessed.
   */
  accountType: string | null;
}

export interface SocialAccountView {
  id: string;
  platform: Platform;
  externalAccountId: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  tokenExpiresAt: string | null;
  destinations: SocialDestinationView[];
}

export interface DestinationDetailView extends SocialDestinationView {
  platform: Platform;
  account: {
    id: string;
    displayName: string;
    platform: Platform;
    status: string;
  };
}

function tokenExpiresAtIso(expiresIn?: number | null): string | null {
  if (!expiresIn || expiresIn <= 0) return null;
  return new Date(Date.now() + expiresIn * 1000).toISOString();
}

/**
 * Upserts the connected account on (workspace_id, platform,
 * external_account_id). A reconnect updates tokens/expiry/status on the
 * SAME row and returns its id.
 */
export async function persistConnectedAccount(
  client: ConnectDbClient | null | undefined,
  input: {
    workspaceId: string;
    platform: Platform;
    exchanged: ExchangedAccount;
  }
): Promise<{ accountId: string; alreadyExisted: boolean }> {
  const encryptionKey = getTokenEncryptionKey();
  const encryptedAccessToken = await encryptToken(
    input.exchanged.accessToken,
    encryptionKey
  );
  const encryptedRefreshToken = input.exchanged.refreshToken
    ? await encryptToken(input.exchanged.refreshToken, encryptionKey)
    : null;
  const expiresAt = tokenExpiresAtIso(input.exchanged.expiresIn);
  const scopes = input.exchanged.scopes ?? [];
  const nowIso = new Date().toISOString();

  // Whether this account row already existed before this flow:
  // the callback reports "already connected — session refreshed"
  // for a re-sign-in with no expected account, and a mismatch when
  // the signed-in account differs from the expected reconnect
  // target. The upsert itself cannot tell us, so check first.
  // A failed check fails the persist loudly rather than guessing.
  let alreadyExisted = false;
  if (isLegacyClient(client ?? undefined)) {
    const existing = (await (client as DatabaseClient).query(
      `SELECT id FROM social_accounts
        WHERE workspace_id = $1 AND platform = $2 AND external_account_id = $3
        LIMIT 1`,
      [input.workspaceId, input.platform, input.exchanged.externalAccountId]
    )) as Array<{ id: string }>;
    alreadyExisted = (existing?.length ?? 0) > 0;
    const rows = (await (client as DatabaseClient).query(
      `INSERT INTO social_accounts (
         workspace_id, platform, external_account_id, display_name, avatar_url,
         encrypted_access_token, encrypted_refresh_token, token_expires_at,
         scopes, status, metadata, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', '{}'::jsonb, now())
       ON CONFLICT (workspace_id, platform, external_account_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url,
         encrypted_access_token = EXCLUDED.encrypted_access_token,
         encrypted_refresh_token = COALESCE(EXCLUDED.encrypted_refresh_token, social_accounts.encrypted_refresh_token),
         token_expires_at = EXCLUDED.token_expires_at,
         scopes = EXCLUDED.scopes,
         status = 'active',
         updated_at = now()
       RETURNING id`,
      [
        input.workspaceId,
        input.platform,
        input.exchanged.externalAccountId,
        input.exchanged.displayName,
        input.exchanged.avatarUrl ?? null,
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt,
        scopes,
      ]
    )) as Array<{ id: string }>;
    const accountId = rows?.[0]?.id;
    if (!accountId) {
      throw new Error('Failed to persist connected account');
    }
    return { accountId, alreadyExisted };
  }

  const supabase = getRouteSupabase(client ?? undefined);
  if (!supabase) {
    throw new Error('Database service unavailable');
  }
  const { data: existingRow, error: existingError } = await supabase
    .from('social_accounts')
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .eq('platform', input.platform)
    .eq('external_account_id', input.exchanged.externalAccountId)
    .maybeSingle();
  if (existingError) {
    throw new Error(
      `Failed to persist connected account: ${existingError.message}`
    );
  }
  alreadyExisted = Boolean(existingRow);
  const { data, error } = await supabase
    .from('social_accounts')
    .upsert(
      {
        workspace_id: input.workspaceId,
        platform: input.platform,
        external_account_id: input.exchanged.externalAccountId,
        display_name: input.exchanged.displayName,
        avatar_url: input.exchanged.avatarUrl ?? null,
        encrypted_access_token: encryptedAccessToken,
        encrypted_refresh_token: encryptedRefreshToken,
        token_expires_at: expiresAt,
        scopes,
        status: STATUS_ACTIVE,
        metadata: {},
        updated_at: nowIso,
      },
      { onConflict: 'workspace_id,platform,external_account_id' }
    )
    .select('id')
    .single();
  if (error || !data?.id) {
    throw new Error(
      `Failed to persist connected account: ${error?.message ?? 'unknown error'}`
    );
  }
  return { accountId: data.id as string, alreadyExisted };
}

/**
 * Inserts the destinations the user picked, ignoring conflicts on
 * (account_id, external_destination_id) so re-picking an already-added
 * destination is a no-op rather than a duplicate.
 */
export async function persistPickedDestinations(
  client: ConnectDbClient | null | undefined,
  input: {
    workspaceId: string;
    accountId: string;
    platform: Platform;
    destinations: DiscoveredDestination[];
  }
): Promise<{ inserted: number }> {
  if (input.destinations.length === 0) {
    return { inserted: 0 };
  }

  if (isLegacyClient(client ?? undefined)) {
    const legacy = client as DatabaseClient;
    const insertResults = await Promise.all(
      input.destinations.map(async (destination): Promise<number> => {
        const rows = (await legacy.query(
          `INSERT INTO destinations (
             workspace_id, account_id, platform, external_destination_id,
             name, handle, avatar_url, status, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', '{}'::jsonb)
           ON CONFLICT (account_id, external_destination_id) DO NOTHING
           RETURNING id`,
          [
            input.workspaceId,
            input.accountId,
            input.platform,
            destination.externalDestinationId,
            destination.name,
            destination.handle ?? null,
            destination.avatarUrl ?? null,
          ]
        )) as Array<{ id: string }>;
        return rows?.[0]?.id ? 1 : 0;
      })
    );
    return { inserted: insertResults.reduce((sum, n) => sum + n, 0) };
  }

  const supabase = getRouteSupabase(client ?? undefined);
  if (!supabase) {
    throw new Error('Database service unavailable');
  }
  const rows = input.destinations.map((destination) => ({
    workspace_id: input.workspaceId,
    account_id: input.accountId,
    platform: input.platform,
    external_destination_id: destination.externalDestinationId,
    name: destination.name,
    handle: destination.handle ?? null,
    avatar_url: destination.avatarUrl ?? null,
    status: STATUS_ACTIVE,
    metadata: {},
  }));
  const { data, error } = await supabase
    .from('destinations')
    .upsert(rows, {
      onConflict: 'account_id,external_destination_id',
      ignoreDuplicates: true,
    })
    .select('id');
  if (error) {
    throw new Error(`Failed to persist destinations: ${error.message}`);
  }
  return { inserted: Array.isArray(data) ? data.length : 0 };
}

/**
 * Reads (never writes) the workspace's BYOC app credentials for a platform
 * from `platform_credentials`, decrypting the secret in memory only.
 */
export async function resolvePlatformClientCredentials(
  client: ConnectDbClient | null | undefined,
  workspaceId: string,
  platform: Platform
): Promise<{ clientId: string; clientSecret: string } | null> {
  const encryptionKey = getTokenEncryptionKey();

  if (isLegacyClient(client ?? undefined)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT client_id, encrypted_client_secret
       FROM platform_credentials
       WHERE workspace_id = $1 AND platform = $2
       LIMIT 1`,
      [workspaceId, platform]
    )) as Array<{ client_id?: string; encrypted_client_secret?: string }>;
    const row = rows?.[0];
    if (!row?.client_id || !row?.encrypted_client_secret) return null;
    return {
      clientId: row.client_id,
      clientSecret: await decryptToken(row.encrypted_client_secret, encryptionKey),
    };
  }

  const supabase = getRouteSupabase(client ?? undefined);
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('platform_credentials')
    .select('client_id, encrypted_client_secret')
    .eq('workspace_id', workspaceId)
    .eq('platform', platform)
    .maybeSingle();
  if (error || !data?.client_id || !data?.encrypted_client_secret) {
    return null;
  }
  return {
    clientId: data.client_id as string,
    clientSecret: await decryptToken(
      data.encrypted_client_secret as string,
      encryptionKey
    ),
  };
}

export interface SocialAccountCandidate {
  id: string;
  workspaceId: string;
}

/**
 * Finds the account rows a platform callback could refer to, by platform
 * and the platform-side account ID. Public callbacks are unauthenticated,
 * so callers must verify the caller's authenticity per row (via the owning
 * workspace) before acting on any of these rows.
 */
export async function findSocialAccountsByExternalId(
  client: ConnectDbClient | null | undefined,
  platform: Platform,
  externalAccountId: string
): Promise<SocialAccountCandidate[]> {
  if (isLegacyClient(client ?? undefined)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT id, workspace_id
       FROM social_accounts
       WHERE platform = $1 AND external_account_id = $2`,
      [platform, externalAccountId]
    )) as Array<{ id?: string; workspace_id?: string; workspaceId?: string }>;
    return (rows ?? [])
      .filter((row) => row.id && (row.workspace_id ?? row.workspaceId))
      .map((row) => ({
        id: row.id as string,
        workspaceId: (row.workspace_id ?? row.workspaceId) as string,
      }));
  }

  const supabase = getRouteSupabase(client ?? undefined);
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('social_accounts')
    .select('id, workspace_id')
    .eq('platform', platform)
    .eq('external_account_id', externalAccountId);
  if (error) {
    console.error('[connect] Failed to find accounts:', error.message);
    return [];
  }
  return ((data ?? []) as Array<Record<string, any>>)
    .filter((row) => row.id && row.workspace_id)
    .map((row) => ({ id: row.id as string, workspaceId: row.workspace_id as string }));
}

/**
 * Marks matching account rows revoked (deauthorize / data-deletion
 * callbacks). When a workspaceId is given, only that workspace's row is
 * revoked — public callbacks must pass it so one workspace's verified
 * notice can never change another workspace's account.
 *
 * Revocation propagates (launch prep, P0-2): for every revoked account,
 * its currently-'active' destinations flip to 'error' and the queued
 * items on those destinations become 'cancelled', so a revoked
 * account can neither accept new queueing (the enqueue gate also
 * blocks 'revoked') nor loop already-queued items through the slot
 * claimer forever. The account's encrypted tokens are nulled — a
 * revoked token must not be retained, let alone refreshed. Propagation
 * and token-nulling are best-effort-loud, not gating: platform
 * callbacks must still answer 200, so a failure is logged loudly and
 * counted in `propagationFailed` rather than failing the revocation
 * itself (the status flip, which every gate reads, always lands).
 */
export async function markSocialAccountRevoked(
  client: ConnectDbClient | null | undefined,
  platform: Platform,
  externalAccountId: string,
  workspaceId?: string
): Promise<{ updated: number; propagationFailed: number }> {
  if (isLegacyClient(client ?? undefined)) {
    const rows = (await (client as DatabaseClient).query(
      workspaceId
        ? `UPDATE social_accounts
           SET status = 'revoked', updated_at = now()
           WHERE platform = $1 AND external_account_id = $2 AND workspace_id = $3
           RETURNING id`
        : `UPDATE social_accounts
           SET status = 'revoked', updated_at = now()
           WHERE platform = $1 AND external_account_id = $2
           RETURNING id`,
      workspaceId
        ? [platform, externalAccountId, workspaceId]
        : [platform, externalAccountId]
    )) as Array<{ id: string }>;
    const accountIds = Array.isArray(rows)
      ? rows.map((row) => row.id).filter(Boolean)
      : [];
    const propagationFailed = await propagateRevocationSideEffects(
      client as DatabaseClient,
      accountIds
    );
    return { updated: accountIds.length, propagationFailed };
  }

  const supabase = getRouteSupabase(client ?? undefined);
  if (!supabase) return { updated: 0, propagationFailed: 0 };
  let updateQuery = supabase
    .from('social_accounts')
    .update({ status: 'revoked', updated_at: new Date().toISOString() })
    .eq('platform', platform)
    .eq('external_account_id', externalAccountId);
  if (workspaceId) {
    updateQuery = updateQuery.eq('workspace_id', workspaceId);
  }
  const { data, error } = await updateQuery.select('id');
  if (error) {
    console.error('[connect] Failed to mark account revoked:', error.message);
    return { updated: 0, propagationFailed: 0 };
  }
  const accountIds = Array.isArray(data)
    ? (data as Array<{ id: string }>).map((row) => row.id).filter(Boolean)
    : [];
  const propagationFailed = await propagateRevocationSideEffects(
    supabase,
    accountIds
  );
  return { updated: accountIds.length, propagationFailed };
}

/**
 * Per-revoked-account side effects: destination/queue propagation plus
 * token nulling. Each account's side effects are independent, so one
 * account's failure never blocks another's — failures are logged
 * loudly with the account id and counted, never thrown (platform
 * callbacks must still answer 200).
 */
async function propagateRevocationSideEffects(
  client: DatabaseClient | SupabaseClient,
  accountIds: string[]
): Promise<number> {
  let propagationFailed = 0;
  for (const accountId of accountIds) {
    try {
      await propagateRevokedAccount(client, accountId);
    } catch (err) {
      propagationFailed++;
      console.error(
        '[connect] Failed to propagate revocation for account:',
        accountId,
        err instanceof Error ? err.message : err
      );
    }
    try {
      if ('query' in client && typeof client.query === 'function') {
        await (client as DatabaseClient).query(
          `UPDATE social_accounts
           SET encrypted_access_token = NULL, encrypted_refresh_token = NULL, updated_at = now()
           encrypted_refresh_token = NULL,
           WHERE id = $1`,
          [accountId]
        );
      } else {
        const { error } = await (client as SupabaseClient)
          .from('social_accounts')
          .update({
            encrypted_access_token: null,
            encrypted_refresh_token: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', accountId);
        if (error) throw new Error(error.message);
      }
    } catch (err) {
      propagationFailed++;
      console.error(
        '[connect] Failed to null revoked account tokens:',
        accountId,
        err instanceof Error ? err.message : err
      );
    }
  }
  return propagationFailed;
}

/**
 * Bounded-pagination bounds for the social list loader (spec 139, B14).
 *
 * PostgREST silently truncates every response at its `max_rows` cap
 * (1,000 by default): an unbounded `select` LOOKS successful while
 * dropping every row past the cap. The loader therefore pages with
 * `.range()` in slices of SOCIAL_LIST_PAGE_SIZE until a short page
 * arrives, and refuses to page forever — past SOCIAL_LIST_MAX_PAGES
 * pages it throws rather than returning a silently truncated list.
 */
export const SOCIAL_LIST_PAGE_SIZE = 1_000;

/** Safety cap on pages per table; exceeding it is a loud error, never a truncation. */
export const SOCIAL_LIST_MAX_PAGES = 100;

interface PagedRowsResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Fetches every row a paged query can return, SOCIAL_LIST_PAGE_SIZE rows
 * at a time, in the query's established order. A page error propagates
 * (the caller never sees a partial list presented as complete), and a
 * result set larger than the page cap throws instead of truncating.
 */
async function fetchAllRowsPaged(
  buildPageQuery: (from: number, to: number) => PromiseLike<PagedRowsResult>,
  failurePrefix: string
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 0; page < SOCIAL_LIST_MAX_PAGES; page++) {
    const from = page * SOCIAL_LIST_PAGE_SIZE;
    const { data, error } = await buildPageQuery(
      from,
      from + SOCIAL_LIST_PAGE_SIZE - 1
    );
    if (error) {
      throw new Error(`${failurePrefix}: ${error.message}`);
    }
    const pageRows = (data ?? []) as Array<Record<string, unknown>>;
    rows.push(...pageRows);
    if (pageRows.length < SOCIAL_LIST_PAGE_SIZE) {
      return rows;
    }
  }
  throw new Error(
    `${failurePrefix}: exceeded the ${SOCIAL_LIST_MAX_PAGES}-page safety cap ` +
      `(${SOCIAL_LIST_MAX_PAGES * SOCIAL_LIST_PAGE_SIZE} rows); ` +
      'refusing to return a truncated list'
  );
}

function mapDestinationRow(row: Record<string, any>): SocialDestinationView {
  return {
    id: row.id,
    externalDestinationId:
      row.external_destination_id ?? row.externalDestinationId,
    name: row.name,
    handle: row.handle ?? null,
    avatarUrl: row.avatar_url ?? row.avatarUrl ?? null,
    timezone: row.timezone ?? 'UTC',
    status: row.status ?? STATUS_ACTIVE,
    accountType: destinationAccountTypeFromMetadata(row.metadata),
  };
}

/**
 * Merges a patch into the `metadata` JSONB of every row in `table`
 * matching ALL of `match` (column → value). The framework's persist
 * step owns row creation; platform complete routes use this for the
 * platform-specific metadata the framework has no field for (the
 * TikTok/YouTube provider account ref, the Instagram account type).
 * The merge is an UPDATE, so a reconnect refreshes the metadata of
 * destinations that already exist — it never creates rows.
 */
export async function mergeRowMetadata(
  client: ConnectDbClient | null | undefined,
  table: 'social_accounts' | 'destinations',
  match: Record<string, string>,
  patch: Record<string, unknown>
): Promise<void> {
  if (isLegacyClient(client ?? undefined)) {
    const legacy = client as DatabaseClient;
    const conditions = Object.keys(match)
      .map((column, index) => `${column} = $${index + 2}`)
      .join(' AND ');
    await legacy.query(
      `UPDATE ${table} SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE ${conditions}`,
      [JSON.stringify(patch), ...Object.values(match)]
    );
    return;
  }

  const supabase = getRouteSupabase(client ?? undefined);
  if (!supabase) return;
  let query = supabase.from(table).select('id, metadata');
  for (const [column, value] of Object.entries(match)) {
    query = query.eq(column, value);
  }
  const { data, error } = await query;
  if (error || !data) return;
  for (const row of data as Array<{
    id: string;
    metadata: Record<string, unknown> | null;
  }>) {
    await supabase
      .from(table)
      .update({ metadata: { ...(row.metadata ?? {}), ...patch } })
      .eq('id', row.id);
  }
}

/**
 * All social accounts in the workspace, each with its destinations.
 *
 * The Supabase path pages both tables with bounded `.range()` slices
 * (spec 139, B14): PostgREST's `max_rows` cap silently truncated the
 * previous unbounded selects at 1,000 rows. Ordering gains a stable
 * secondary `id` key — `created_at` alone is not unique, and page
 * boundaries over a non-unique order can skip or repeat rows. The
 * legacy path queries Postgres directly (no PostgREST cap applies)
 * and keeps the same primary + secondary ordering.
 */
export async function fetchSocialAccountsWithDestinations(
  client: ConnectDbClient | null | undefined,
  workspaceId: string
): Promise<SocialAccountView[]> {
  let accountRows: Array<Record<string, any>> = [];
  let destinationRows: Array<Record<string, any>> = [];

  if (isLegacyClient(client ?? undefined)) {
    const legacy = client as DatabaseClient;
    accountRows = (await legacy.query(
      `SELECT * FROM social_accounts WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
      [workspaceId]
    )) as Array<Record<string, any>>;
    destinationRows = (await legacy.query(
      `SELECT * FROM destinations WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`,
      [workspaceId]
    )) as Array<Record<string, any>>;
  } else {
    const supabase = getRouteSupabase(client ?? undefined);
    if (!supabase) return [];
    accountRows = await fetchAllRowsPaged(
      (from, to) =>
        supabase
          .from('social_accounts')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to),
      'Failed to load connected accounts'
    );
    destinationRows = await fetchAllRowsPaged(
      (from, to) =>
        supabase
          .from('destinations')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      'Failed to load destinations'
    );
  }

  const destinationsByAccount = new Map<string, SocialDestinationView[]>();
  for (const row of destinationRows) {
    const accountId = row.account_id ?? row.accountId;
    const list = destinationsByAccount.get(accountId) ?? [];
    list.push(mapDestinationRow(row));
    destinationsByAccount.set(accountId, list);
  }

  return accountRows.map((row) => ({
    id: row.id,
    platform: (row.platform ?? FALLBACK_PLATFORM) as Platform,
    externalAccountId: row.external_account_id ?? row.externalAccountId,
    displayName: row.display_name ?? row.displayName,
    avatarUrl: row.avatar_url ?? row.avatarUrl ?? null,
    status: row.status ?? STATUS_ACTIVE,
    tokenExpiresAt: row.token_expires_at ?? row.tokenExpiresAt ?? null,
    destinations: destinationsByAccount.get(row.id) ?? [],
  }));
}

/** One destination plus its owning account, scoped to the workspace. */
export async function fetchDestinationDetail(
  client: ConnectDbClient | null | undefined,
  workspaceId: string,
  destinationId: string
): Promise<DestinationDetailView | null> {
  if (isLegacyClient(client ?? undefined)) {
    const rows = (await (client as DatabaseClient).query(
      `SELECT d.*, a.display_name AS account_display_name, a.status AS account_status
       FROM destinations d
       JOIN social_accounts a ON a.id = d.account_id
       WHERE d.id = $1 AND d.workspace_id = $2
       LIMIT 1`,
      [destinationId, workspaceId]
    )) as Array<Record<string, any>>;
    const row = rows?.[0];
    if (!row) return null;
    return {
      ...mapDestinationRow(row),
      platform: (row.platform ?? FALLBACK_PLATFORM) as Platform,
      account: {
        id: row.account_id ?? row.accountId,
        displayName: row.account_display_name ?? row.accountDisplayName,
        platform: (row.platform ?? FALLBACK_PLATFORM) as Platform,
        status: row.account_status ?? row.accountStatus ?? STATUS_ACTIVE,
      },
    };
  }

  const supabase = getRouteSupabase(client ?? undefined);
  if (!supabase) return null;
  const { data: destination, error } = await supabase
    .from('destinations')
    .select('*')
    .eq('id', destinationId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error || !destination) return null;
  const { data: account } = await supabase
    .from('social_accounts')
    .select('id, display_name, platform, status')
    .eq('id', destination.account_id)
    .maybeSingle();
  if (!account) return null;
  return {
    ...mapDestinationRow(destination as Record<string, any>),
    platform: destination.platform as Platform,
    account: {
      id: account.id as string,
      displayName: account.display_name as string,
      platform: account.platform as Platform,
      status: (account.status as string) ?? STATUS_ACTIVE,
    },
  };
}
