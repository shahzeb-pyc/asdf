import { z } from 'zod';
import {
  encryptToken,
  getTokenEncryptionKey,
  type DatabaseClient,
  type DatabasePlatformCredentialsRow,
  type Platform,
} from '@fbuploadpro/contracts';
import { isLegacyClient, getRouteSupabase } from '@/lib/route-auth';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Per-platform credentials service (spec 123, Part A).
 *
 * All reads and writes go to the unified `platform_credentials` table
 * (spec 120), keyed by (workspace_id, platform). Rows exist ONLY for the
 * bring-your-own-app platforms — facebook, instagram, threads. YouTube and
 * TikTok connect through our publishing partner and X uses our own single
 * app, so this service refuses to read or write rows for them.
 */

export type ByocPlatform = 'facebook' | 'instagram' | 'threads';

export const BYOC_PLATFORMS: readonly ByocPlatform[] = ['facebook', 'instagram', 'threads'];

const PLATFORM_LABELS: Record<ByocPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
};

export function isByocPlatform(platform: string): platform is ByocPlatform {
  return (BYOC_PLATFORMS as readonly string[]).includes(platform);
}

export function platformLabel(platform: ByocPlatform): string {
  return PLATFORM_LABELS[platform];
}

/**
 * The masked hint a settings payload may carry for a stored secret
 * (spec 139 N3): bullets plus the last four characters — the same
 * convention as a card number. The full secret NEVER travels in a
 * settings GET response; it is disclosed only by the dedicated
 * reveal action. A secret of four characters or fewer yields the
 * bullets alone, so the hint can never BE the secret.
 */
export function toSecretHint(decryptedSecret: string): string {
  if (decryptedSecret.length <= 4) return '••••';
  return `••••${decryptedSecret.slice(-4)}`;
}

export class UnsupportedPlatformError extends Error {
  readonly platform: string;

  constructor(platform: string) {
    super(
      `App credentials are only managed for Facebook, Instagram, and Threads. "${platform}" does not use app details you add here.`
    );
    this.name = 'UnsupportedPlatformError';
    this.platform = platform;
  }
}

function assertByocPlatform(platform: Platform | string): asserts platform is ByocPlatform {
  if (!isByocPlatform(platform)) {
    throw new UnsupportedPlatformError(platform);
  }
}

export type PlatformCredentialStatus = DatabasePlatformCredentialsRow['status'];

export interface PlatformCredentialsRecord {
  id: string | null;
  workspaceId: string;
  platform: ByocPlatform;
  clientId: string;
  encryptedClientSecret: string;
  status: PlatformCredentialStatus;
  lastTestedAt: string | null;
  /** Provider app display name from a verification fetch (null until first verification). */
  appName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SavePlatformCredentialsInput {
  clientId: string;
  clientSecret?: string | undefined;
  /**
   * App display name fetched from the provider's API by a verification
   * step the caller performed BEFORE saving (Facebook BYOC connect).
   * When present, the row is written as verified with this name and
   * the test timestamp in the same write; when absent, today's
   * behavior is preserved (status resets to 'unverified', and the
   * stored name and test timestamp are left untouched).
   */
  verifiedAppName?: string | undefined;
}

/**
 * The verification outcome a caller attaches to a save: the row is
 * written as 'valid' with the fetched name and the test time, in the
 * same write that stores the credentials — never as a second write
 * that could leave a verified name on an unverified row (or vice
 * versa) if it failed.
 */
interface VerifiedWrite {
  status: 'valid';
  lastTestedAt: string;
  appName: string;
}

export type PlatformCredentialsMutationResult =
  | { ok: true }
  | { ok: false; error: string; status: number };

type CredentialsClient = DatabaseClient | SupabaseClient | null | undefined;

/** Outcome of a low-level write: success, a database error, or no database available. */
type WriteOutcome = 'ok' | 'error' | 'unavailable';

const CREDENTIAL_COLUMNS =
  'id, workspace_id, platform, client_id, encrypted_client_secret, status, last_tested_at, app_name, created_at, updated_at';

interface CredentialsRowShape {
  id?: string | null;
  workspace_id?: string;
  platform?: string;
  client_id?: string;
  encrypted_client_secret?: string;
  status?: string;
  last_tested_at?: string | null;
  app_name?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function toRecord(row: CredentialsRowShape, workspaceId: string, platform: ByocPlatform): PlatformCredentialsRecord {
  return {
    id: row.id ?? null,
    workspaceId: row.workspace_id ?? workspaceId,
    platform,
    clientId: row.client_id ?? '',
    encryptedClientSecret: row.encrypted_client_secret ?? '',
    status: (row.status as PlatformCredentialStatus) || 'unverified',
    lastTestedAt: row.last_tested_at ?? null,
    appName: row.app_name ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** Request body for saving a platform's app details (generic instagram/threads route). */
export const SavePlatformCredentialsRequestSchema = z.object({
  appId: z
    .string()
    .trim()
    .min(1, 'Enter the App ID for this platform.')
    .max(100, 'That App ID is too long. Check it and try again.'),
  appSecret: z
    .string()
    .trim()
    .max(128, 'That App Secret is too long. Check it and try again.')
    .optional()
    .or(z.literal('')),
});
export type SavePlatformCredentialsRequest = z.infer<typeof SavePlatformCredentialsRequestSchema>;

function legacyDb(client: CredentialsClient): DatabaseClient | null {
  return isLegacyClient(client ?? undefined) ? (client as DatabaseClient) : null;
}

function supabaseDb(client: CredentialsClient): SupabaseClient | null {
  if (legacyDb(client)) return null;
  return getRouteSupabase(client ?? undefined);
}

async function fetchRow(
  workspaceId: string,
  platform: ByocPlatform,
  client: CredentialsClient
): Promise<CredentialsRowShape | null> {
  const legacy = legacyDb(client);
  if (legacy) {
    try {
      const rows = (await legacy.query(
        `SELECT ${CREDENTIAL_COLUMNS}
         FROM platform_credentials
         WHERE workspace_id = $1 AND platform = $2
         LIMIT 1`,
        [workspaceId, platform]
      )) as CredentialsRowShape[];
      return rows?.[0] ?? null;
    } catch (err) {
      console.error('[Platform Credentials] Failed to read credentials (legacy client):', err);
      return null;
    }
  }

  const supabase = supabaseDb(client);
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('platform_credentials')
      .select(CREDENTIAL_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('platform', platform)
      .maybeSingle();
    if (error || !data) return null;
    return data as CredentialsRowShape;
  } catch (err) {
    console.error('[Platform Credentials] Failed to read credentials:', err);
    return null;
  }
}

async function upsertRow(
  workspaceId: string,
  platform: ByocPlatform,
  clientId: string,
  encryptedClientSecret: string,
  now: string,
  client: CredentialsClient,
  verification: VerifiedWrite | null
): Promise<WriteOutcome> {
  const legacy = legacyDb(client);
  if (legacy) {
    try {
      if (verification) {
        await legacy.query(
          `INSERT INTO platform_credentials (workspace_id, platform, client_id, encrypted_client_secret, status, last_tested_at, app_name, updated_at)
           VALUES ($1, $2, $3, $4, 'valid', $5, $6, $7)
           ON CONFLICT (workspace_id, platform) DO UPDATE SET
             client_id = EXCLUDED.client_id,
             encrypted_client_secret = EXCLUDED.encrypted_client_secret,
             status = 'valid',
             last_tested_at = EXCLUDED.last_tested_at,
             app_name = EXCLUDED.app_name,
             updated_at = EXCLUDED.updated_at`,
          [
            workspaceId,
            platform,
            clientId,
            encryptedClientSecret,
            verification.lastTestedAt,
            verification.appName,
            now,
          ]
        );
      } else {
        await legacy.query(
          `INSERT INTO platform_credentials (workspace_id, platform, client_id, encrypted_client_secret, status, updated_at)
           VALUES ($1, $2, $3, $4, 'unverified', $5)
           ON CONFLICT (workspace_id, platform) DO UPDATE SET
             client_id = EXCLUDED.client_id,
             encrypted_client_secret = EXCLUDED.encrypted_client_secret,
             status = 'unverified',
             updated_at = EXCLUDED.updated_at`,
          [workspaceId, platform, clientId, encryptedClientSecret, now]
        );
      }
      return 'ok';
    } catch (err) {
      console.error('[Platform Credentials] Failed to save credentials (legacy client):', err);
      return 'error';
    }
  }

  const supabase = supabaseDb(client);
  if (!supabase) return 'unavailable';

  const { error } = await supabase.from('platform_credentials').upsert(
    {
      workspace_id: workspaceId,
      platform,
      client_id: clientId,
      encrypted_client_secret: encryptedClientSecret,
      status: verification ? 'valid' : 'unverified',
      ...(verification
        ? { last_tested_at: verification.lastTestedAt, app_name: verification.appName }
        : {}),
      updated_at: now,
    },
    { onConflict: 'workspace_id,platform' }
  );
  if (error) {
    console.error('[Platform Credentials] Upsert credentials error:', error);
    return 'error';
  }
  return 'ok';
}

async function updateRow(
  workspaceId: string,
  platform: ByocPlatform,
  patch: {
    client_id?: string;
    status: PlatformCredentialStatus;
    last_tested_at?: string;
    app_name?: string;
  },
  client: CredentialsClient,
  now: string
): Promise<WriteOutcome> {
  const legacy = legacyDb(client);
  if (legacy) {
    try {
      // Only the columns the caller actually supplies are set, so an
      // unverified re-save never wipes a stored name or test time.
      // Column order is fixed (client_id, status, last_tested_at,
      // app_name, updated_at) so the two pre-existing shapes keep the
      // exact SQL and parameter positions they always had.
      const sets: string[] = [];
      const params: unknown[] = [workspaceId, platform];
      let nextParam = 3;
      if (patch.client_id !== undefined) {
        sets.push(`client_id = $${nextParam++}`);
        params.push(patch.client_id);
      }
      sets.push(`status = $${nextParam++}`);
      params.push(patch.status);
      if (patch.last_tested_at !== undefined) {
        sets.push(`last_tested_at = $${nextParam++}`);
        params.push(patch.last_tested_at);
      }
      if (patch.app_name !== undefined) {
        sets.push(`app_name = $${nextParam++}`);
        params.push(patch.app_name);
      }
      sets.push(`updated_at = $${nextParam++}`);
      params.push(now);
      await legacy.query(
        `UPDATE platform_credentials SET ${sets.join(', ')} WHERE workspace_id = $1 AND platform = $2`,
        params
      );
      return 'ok';
    } catch (err) {
      console.error('[Platform Credentials] Failed to update credentials (legacy client):', err);
      return 'error';
    }
  }

  const supabase = supabaseDb(client);
  if (!supabase) return 'unavailable';

  const { error } = await supabase
    .from('platform_credentials')
    .update({ ...patch, updated_at: now })
    .eq('workspace_id', workspaceId)
    .eq('platform', platform);
  if (error) {
    console.error('[Platform Credentials] Update credentials error:', error);
    return 'error';
  }
  return 'ok';
}

async function deleteRow(
  workspaceId: string,
  platform: ByocPlatform,
  client: CredentialsClient
): Promise<WriteOutcome> {
  const legacy = legacyDb(client);
  if (legacy) {
    try {
      await legacy.query(
        `DELETE FROM platform_credentials WHERE workspace_id = $1 AND platform = $2`,
        [workspaceId, platform]
      );
      return 'ok';
    } catch (err) {
      console.error('[Platform Credentials] Failed to delete credentials (legacy client):', err);
      return 'error';
    }
  }

  const supabase = supabaseDb(client);
  if (!supabase) return 'unavailable';

  const { error } = await supabase
    .from('platform_credentials')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('platform', platform);
  if (error) {
    console.error('[Platform Credentials] Delete credentials error:', error);
    return 'error';
  }
  return 'ok';
}

function outcomeToResult(outcome: WriteOutcome, errorMessage: string): PlatformCredentialsMutationResult {
  if (outcome === 'ok') return { ok: true };
  if (outcome === 'unavailable') {
    return { ok: false, error: 'Database service unavailable', status: 503 };
  }
  return { ok: false, error: errorMessage, status: 500 };
}

/**
 * Returns the stored credentials row for a workspace + BYOC platform, or
 * null when none has been saved yet. Throws UnsupportedPlatformError for
 * youtube / x / tiktok.
 */
export async function getCredentials(
  workspaceId: string,
  platform: Platform | string,
  client?: CredentialsClient
): Promise<PlatformCredentialsRecord | null> {
  assertByocPlatform(platform);
  const row = await fetchRow(workspaceId, platform, client);
  return row ? toRecord(row, workspaceId, platform) : null;
}

/**
 * Saves a workspace's app details for a BYOC platform. A supplied secret is
 * encrypted before storage; when no new secret is supplied, the previously
 * saved secret is kept (and saving fails if there is none yet). Without a
 * caller-supplied verification, saving resets the status to 'unverified'
 * until the details are tested, leaving any stored name and test time
 * untouched. With `verifiedAppName` (a name the caller just fetched from
 * the provider's API for exactly this pair), the same write stores the
 * name and marks the row 'valid' with the test time — the verification
 * is never a second write. Only the platform_credentials row is
 * written — connected accounts and their tokens are never touched.
 */
export async function saveCredentials(
  workspaceId: string,
  platform: Platform | string,
  input: SavePlatformCredentialsInput,
  client?: CredentialsClient
): Promise<PlatformCredentialsMutationResult> {
  assertByocPlatform(platform);
  const now = new Date().toISOString();
  const hasNewSecret = Boolean(input.clientSecret && input.clientSecret.length > 0);
  const verification: VerifiedWrite | null =
    input.verifiedAppName !== undefined
      ? { status: 'valid', lastTestedAt: now, appName: input.verifiedAppName }
      : null;

  if (!hasNewSecret) {
    const existing = await fetchRow(workspaceId, platform, client);
    if (!existing?.encrypted_client_secret) {
      return {
        ok: false,
        error: `Enter your ${PLATFORM_LABELS[platform]} App Secret to complete setup.`,
        status: 400,
      };
    }
    const outcome = await updateRow(
      workspaceId,
      platform,
      {
        client_id: input.clientId,
        status: verification ? 'valid' : 'unverified',
        ...(verification
          ? { last_tested_at: verification.lastTestedAt, app_name: verification.appName }
          : {}),
      },
      client,
      now
    );
    return outcomeToResult(outcome, 'Failed to update credentials');
  }

  let encryptedSecret: string;
  try {
    encryptedSecret = await encryptToken(input.clientSecret as string, getTokenEncryptionKey());
  } catch (err) {
    console.error('[Platform Credentials] Failed to encrypt client secret:', err);
    return { ok: false, error: 'Failed to save credentials', status: 500 };
  }

  const outcome = await upsertRow(
    workspaceId,
    platform,
    input.clientId,
    encryptedSecret,
    now,
    client,
    verification
  );
  return outcomeToResult(outcome, 'Failed to save credentials');
}

/**
 * Deletes ONLY the credentials row for a workspace + BYOC platform.
 * Connected accounts, destinations, media, and scheduled posts remain
 * fully intact — posting continues, but no new accounts can be connected
 * for that platform until details are added again.
 */
export async function deleteCredentials(
  workspaceId: string,
  platform: Platform | string,
  client?: CredentialsClient
): Promise<PlatformCredentialsMutationResult> {
  assertByocPlatform(platform);
  const outcome = await deleteRow(workspaceId, platform, client);
  return outcomeToResult(outcome, `Failed to disconnect ${PLATFORM_LABELS[platform]}`);
}

/**
 * Records the outcome of a credentials test: updates the row's status and
 * the time it was last tested, without changing the stored details.
 */
export async function updateCredentialsTestResult(
  workspaceId: string,
  platform: Platform | string,
  result: { status: PlatformCredentialStatus; lastTestedAt?: string },
  client?: CredentialsClient
): Promise<PlatformCredentialsMutationResult> {
  assertByocPlatform(platform);
  const outcome = await updateRow(
    workspaceId,
    platform,
    { status: result.status, last_tested_at: result.lastTestedAt ?? new Date().toISOString() },
    client,
    new Date().toISOString()
  );
  return outcomeToResult(outcome, 'Failed to update credentials status');
}
