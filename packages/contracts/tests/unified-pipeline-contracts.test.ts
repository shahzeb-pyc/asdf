import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  DatabaseDestinationMetadataSchema,
  DatabaseDestinationRowSchema,
  DatabaseSocialAccountRowSchema,
  destinationAccountTypeFromMetadata,
  DatabaseUnifiedQueueItemRowSchema,
  PUBLISH_QUEUE_MESSAGE_SCHEMA_VERSION,
  PublishOutcomeSchema,
  PublishQueueMessageSchema,
  type ClaimedUnifiedQueueItemRpcResult,
  type ClaimDueQueueItemsUnifiedArgs,
  type Database,
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type Platform,
  type PublishLane,
  type PublishOutcome,
  type PublishQueueMessage,
  type PublishQueueMessageInput,
  type RecoverStuckPublishingItemsUnifiedArgs,
  type SettleQueueItemOutcomeUnifiedArgs,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Type-level parity with the migrations (20261022120000 §6, 20261022140000).
// These assertions are checked by `tsc -p tests/tsconfig.json`; the runtime
// expects below just keep the constants from being elided.
// ---------------------------------------------------------------------------

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type Functions = Database['public']['Functions'];

// claim: Database.Functions records the UNIFIED 4-arg overload, whose
// second argument is required (the migration gives it no default).
const claimFunctionsArgsAreUnified: Equals<
  Functions['claim_due_queue_items']['Args'],
  ClaimDueQueueItemsUnifiedArgs
> = true;
const claimArgsMatchMigration: Equals<
  ClaimDueQueueItemsUnifiedArgs,
  {
    p_platform: Platform;
    p_lane_kind_set: string[] | null;
    p_limit?: number;
    p_max_per_destination?: number;
  }
> = true;
const claimReturnsUnifiedRows: Equals<
  Functions['claim_due_queue_items']['Returns'],
  ClaimedUnifiedQueueItemRpcResult[]
> = true;

// settle: unified 16-arg shape (TEXT error codes) + optional p_detail.
const settleFunctionsArgsAreUnified: Equals<
  Functions['settle_queue_item_outcome']['Args'],
  SettleQueueItemOutcomeUnifiedArgs
> = true;
const settleArgsMatchMigration: Equals<
  SettleQueueItemOutcomeUnifiedArgs,
  {
    p_queue_item_id: string;
    p_workspace_id: string;
    p_destination_id: string;
    p_outcome_status: string;
    p_external_post_id?: string | null;
    p_external_comment_id?: string | null;
    p_retry_count?: number;
    p_retry_delay_seconds?: number;
    p_error_code?: string | null;
    p_error_subcode?: string | null;
    p_error_message?: string | null;
    p_comment_warning?: string | null;
    p_target_destination_status?: string | null;
    p_target_account_status?: string | null;
    p_rate_usage_pct?: number | null;
    p_detail?: Record<string, unknown> | null;
  }
> = true;
const settleReturnsVoid: Equals<
  Functions['settle_queue_item_outcome']['Returns'],
  void
> = true;

// recover: unified (platform, timeout) overload returning INT.
const recoverFunctionsArgsAreUnified: Equals<
  Functions['recover_stuck_publishing_items']['Args'],
  RecoverStuckPublishingItemsUnifiedArgs
> = true;
const recoverArgsMatchMigration: Equals<
  RecoverStuckPublishingItemsUnifiedArgs,
  { p_platform: Platform; p_timeout_minutes?: number }
> = true;
const recoverReturnsNumber: Equals<
  Functions['recover_stuck_publishing_items']['Returns'],
  number
> = true;

// The pre-unification overload typings are GONE (Phase 7 drop,
// migration 20261024130000): Database.Tables carries exactly the
// surviving unified table set — no legacy table entries remain.
type Tables = Database['public']['Tables'];
const tablesAreUnifiedOnly: Equals<
  keyof Tables,
  | 'users'
  | 'workspaces'
  | 'media_folders'
  | 'media_items'
  | 'platform_credentials'
  | 'social_accounts'
  | 'destinations'
  | 'posting_slots'
  | 'queue_items'
  | 'publish_logs'
> = true;

describe('RPC typing parity (type-level, asserted at compile time)', () => {
  it('Database.Functions records the unified claim/settle/recover signatures', () => {
    expect(claimFunctionsArgsAreUnified).toBe(true);
    expect(claimArgsMatchMigration).toBe(true);
    expect(claimReturnsUnifiedRows).toBe(true);
    expect(settleFunctionsArgsAreUnified).toBe(true);
    expect(settleArgsMatchMigration).toBe(true);
    expect(settleReturnsVoid).toBe(true);
    expect(recoverFunctionsArgsAreUnified).toBe(true);
    expect(recoverArgsMatchMigration).toBe(true);
    expect(recoverReturnsNumber).toBe(true);
    expect(tablesAreUnifiedOnly).toBe(true);
  });

  it('schema-inferred row/message types keep the expected field vocabularies', () => {
    expectTypeOf<DatabaseUnifiedQueueItemRow['status']>().toEqualTypeOf<
      'queued' | 'publishing' | 'published' | 'failed' | 'cancelled'
    >();
    expectTypeOf<DatabaseUnifiedQueueItemRow['kind']>().toEqualTypeOf<
      'text' | 'image' | 'video' | 'story' | 'carousel'
    >();
    expectTypeOf<DatabaseSocialAccountRow['status']>().toEqualTypeOf<
      'active' | 'expired' | 'revoked' | 'error'
    >();
    expectTypeOf<DatabaseDestinationRow['status']>().toEqualTypeOf<
      'active' | 'rate_limited' | 'disconnected' | 'error'
    >();
    expectTypeOf<PublishQueueMessage['lane']>().toEqualTypeOf<PublishLane>();
    expectTypeOf<PublishQueueMessage['platform']>().toEqualTypeOf<Platform>();
    expectTypeOf<PublishQueueMessage['schemaVersion']>().toEqualTypeOf<number>();
    // Producers may omit the version; the schema default fills it.
    expectTypeOf<PublishQueueMessageInput['schemaVersion']>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<PublishOutcome['status']>().toEqualTypeOf<
      'published' | 'retry' | 'failed'
    >();
  });
});

// ---------------------------------------------------------------------------
// Fixtures: rows exactly as PostgREST returns them from the unified tables.
// ---------------------------------------------------------------------------

const IDS = {
  workspace: '11111111-1111-4111-8111-111111111111',
  account: '22222222-2222-4222-8222-222222222222',
  destination: '33333333-3333-4333-8333-333333333333',
  item: '44444444-4444-4444-8444-444444444444',
  media: '55555555-5555-4555-8555-555555555555',
  slot: '66666666-6666-4666-8666-666666666666',
};

const validQueueItemRow: DatabaseUnifiedQueueItemRow = {
  id: IDS.item,
  workspace_id: IDS.workspace,
  destination_id: IDS.destination,
  platform: 'facebook',
  kind: 'video',
  platform_format: 'reel',
  caption: 'hello',
  title: null,
  first_comment: 'first!',
  media_item_id: IDS.media,
  media_url: 'https://cdn.example.com/v.mp4',
  media_storage_key: 'tenant/v.mp4',
  link_url: null,
  platform_options: {},
  scheduled_time: '2026-10-22T00:00:00.000Z',
  slot_id: IDS.slot,
  status: 'queued',
  claimed_at: null,
  retry_count: 0,
  max_retries: 3,
  error_code: null,
  error_subcode: null,
  error_message: null,
  external_post_id: null,
  external_comment_id: null,
  created_at: '2026-10-22T00:00:00+00:00',
  updated_at: '2026-10-22T00:00:00.000Z',
};

const validSocialAccountRow: DatabaseSocialAccountRow = {
  id: IDS.account,
  workspace_id: IDS.workspace,
  platform: 'instagram',
  external_account_id: 'ig-123',
  display_name: 'Account',
  avatar_url: null,
  encrypted_access_token: 'ciphertext',
  encrypted_refresh_token: null,
  token_expires_at: '2026-12-22T00:00:00.000Z',
  scopes: ['instagram_basic'],
  status: 'active',
  metadata: {},
  created_at: '2026-10-22T00:00:00.000Z',
  updated_at: '2026-10-22T00:00:00.000Z',
};

const validDestinationRow: DatabaseDestinationRow = {
  id: IDS.destination,
  workspace_id: IDS.workspace,
  account_id: IDS.account,
  platform: 'facebook',
  external_destination_id: 'page-123',
  name: 'Page',
  handle: null,
  avatar_url: null,
  timezone: 'UTC',
  status: 'active',
  encrypted_destination_token: 'ciphertext',
  rate_usage_pct: 0,
  metadata: {},
  created_at: '2026-10-22T00:00:00.000Z',
  updated_at: '2026-10-22T00:00:00.000Z',
};

describe('DatabaseUnifiedQueueItemRowSchema', () => {
  it('accepts a valid row and round-trips it through JSON', () => {
    const parsed = DatabaseUnifiedQueueItemRowSchema.parse(validQueueItemRow);
    expect(parsed).toEqual(validQueueItemRow);
    const reparsed = DatabaseUnifiedQueueItemRowSchema.parse(
      JSON.parse(JSON.stringify(parsed))
    );
    expect(reparsed).toEqual(validQueueItemRow);
  });

  it('rejects legacy vocabulary that the unified table cannot hold', () => {
    // 'skipped' was backfilled to 'cancelled'; 'reel' is a platform_format, not a kind.
    expect(
      DatabaseUnifiedQueueItemRowSchema.safeParse({ ...validQueueItemRow, status: 'skipped' }).success
    ).toBe(false);
    expect(
      DatabaseUnifiedQueueItemRowSchema.safeParse({ ...validQueueItemRow, kind: 'reel' }).success
    ).toBe(false);
  });

  it('accepts a NULL platform_credentials_id and platform platform_options keys (spec 139 B15)', () => {
    // Managed / global-app platforms hold no per-workspace credentials
    // row, so the FK legitimately arrives NULL; platform_options is a
    // free-form record whose platform keys (e.g. a TikTok soundId)
    // pass through untouched.
    const parsed = DatabaseUnifiedQueueItemRowSchema.parse({
      ...validQueueItemRow,
      platform_credentials_id: null,
      platform_options: { soundId: 'sound-123', customKey: 'x' },
    });
    expect(parsed.platform_credentials_id).toBeNull();
    expect(parsed.platform_options).toEqual({ soundId: 'sound-123', customKey: 'x' });
    const withCredentials = DatabaseUnifiedQueueItemRowSchema.parse({
      ...validQueueItemRow,
      platform_credentials_id: IDS.account,
    });
    expect(withCredentials.platform_credentials_id).toBe(IDS.account);
    expect(
      DatabaseUnifiedQueueItemRowSchema.safeParse({
        ...validQueueItemRow,
        platform_credentials_id: 'not-a-uuid',
      }).success
    ).toBe(false);
  });

  it('accepts a NULL scheduled_time (2026-11-02 stuck post)', () => {
    // The column has been nullable since 20261027130000 and the
    // Facebook retry/deferred settle NULLs it; requiring a string
    // threw ValidationError in the consumer before publishing.
    const parsed = DatabaseUnifiedQueueItemRowSchema.parse({
      ...validQueueItemRow,
      scheduled_time: null,
    });
    expect(parsed.scheduled_time).toBeNull();
  });

  it('rejects malformed rows', () => {
    expect(
      DatabaseUnifiedQueueItemRowSchema.safeParse({ ...validQueueItemRow, error_code: 190 }).success
    ).toBe(false); // unified error codes are TEXT
    expect(
      DatabaseUnifiedQueueItemRowSchema.safeParse({ ...validQueueItemRow, id: 'not-a-uuid' }).success
    ).toBe(false);
    expect(
      DatabaseUnifiedQueueItemRowSchema.safeParse({ ...validQueueItemRow, retry_count: -1 }).success
    ).toBe(false);
    expect(
      DatabaseUnifiedQueueItemRowSchema.safeParse({ ...validQueueItemRow, platform: 'myspace' }).success
    ).toBe(false);
    const { workspace_id: _dropped, ...missingWorkspace } = validQueueItemRow;
    expect(DatabaseUnifiedQueueItemRowSchema.safeParse(missingWorkspace).success).toBe(false);
  });
});

describe('DatabaseSocialAccountRowSchema', () => {
  it('accepts a valid row and round-trips it', () => {
    const parsed = DatabaseSocialAccountRowSchema.parse(validSocialAccountRow);
    expect(parsed).toEqual(validSocialAccountRow);
    expect(DatabaseSocialAccountRowSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      validSocialAccountRow
    );
  });

  it('rejects the pre-unification account status vocabulary', () => {
    // The old account table's 'disconnected' backfilled to 'revoked' in social_accounts.
    expect(
      DatabaseSocialAccountRowSchema.safeParse({ ...validSocialAccountRow, status: 'disconnected' })
        .success
    ).toBe(false);
    expect(
      DatabaseSocialAccountRowSchema.safeParse({ ...validSocialAccountRow, scopes: 'instagram_basic' })
        .success
    ).toBe(false);
  });
});

describe('DatabaseDestinationRowSchema', () => {
  it('accepts a valid row and round-trips it', () => {
    const parsed = DatabaseDestinationRowSchema.parse(validDestinationRow);
    expect(parsed).toEqual(validDestinationRow);
    expect(DatabaseDestinationRowSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      validDestinationRow
    );
  });

  it('passes through unmodelled platform data on a real row (spec 139 B15)', () => {
    // A real destination row may carry platform data the schema does
    // not model (e.g. a platform_options record with a TikTok
    // soundId); boundary validation must preserve it, not strip it.
    const parsed = DatabaseDestinationRowSchema.parse({
      ...validDestinationRow,
      platform_options: { soundId: 'sound-123' },
    } as DatabaseDestinationRow);
    expect(
      (parsed as unknown as Record<string, unknown>).platform_options
    ).toEqual({ soundId: 'sound-123' });
  });

  it('validates the modelled metadata keys and passes the rest through', () => {
    // The provider-reported account type is a modelled, validated key.
    const withType = DatabaseDestinationRowSchema.parse({
      ...validDestinationRow,
      metadata: { account_type: 'BUSINESS', providerAccountId: 'sa_1' },
    });
    expect(withType.metadata).toEqual({
      account_type: 'BUSINESS',
      providerAccountId: 'sa_1',
    });
    // A malformed account_type fails the row loudly instead of
    // silently flowing to the story gate.
    expect(
      DatabaseDestinationRowSchema.safeParse({
        ...validDestinationRow,
        metadata: { account_type: 42 },
      }).success
    ).toBe(false);
    expect(
      DatabaseDestinationMetadataSchema.safeParse({ account_type: '' }).success
    ).toBe(false);
  });

  it('rejects out-of-range rate usage and legacy page statuses', () => {
    expect(
      DatabaseDestinationRowSchema.safeParse({ ...validDestinationRow, rate_usage_pct: 101 }).success
    ).toBe(false);
    expect(
      DatabaseDestinationRowSchema.safeParse({ ...validDestinationRow, status: 'paused' }).success
    ).toBe(false);
    expect(
      DatabaseDestinationRowSchema.safeParse({ ...validDestinationRow, status: 'fb_rate_limited' })
        .success
    ).toBe(false);
  });
});

describe('destinationAccountTypeFromMetadata', () => {
  it('returns the persisted account type verbatim', () => {
    expect(destinationAccountTypeFromMetadata({ account_type: 'BUSINESS' })).toBe(
      'BUSINESS'
    );
    expect(
      destinationAccountTypeFromMetadata({ account_type: 'MEDIA_CREATOR' })
    ).toBe('MEDIA_CREATOR');
  });

  it('returns null for unknown or malformed metadata — never a guess', () => {
    expect(destinationAccountTypeFromMetadata({})).toBeNull();
    expect(
      destinationAccountTypeFromMetadata({ providerAccountId: 'sa_1' })
    ).toBeNull();
    expect(destinationAccountTypeFromMetadata({ account_type: 42 })).toBeNull();
    expect(destinationAccountTypeFromMetadata(null)).toBeNull();
    expect(destinationAccountTypeFromMetadata(undefined)).toBeNull();
    expect(destinationAccountTypeFromMetadata('BUSINESS')).toBeNull();
  });
});

describe('PublishQueueMessageSchema', () => {
  it('accepts a valid message and round-trips it', () => {
    const message = {
      itemId: IDS.item,
      platform: 'facebook' as const,
      lane: 'publish-heavy' as const,
      schemaVersion: 1,
    };
    const parsed = PublishQueueMessageSchema.parse(message);
    expect(parsed).toEqual(message);
    expect(PublishQueueMessageSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(message);
  });

  it('defaults schemaVersion for messages produced by current (unversioned) code', () => {
    const legacyWireMessage = { itemId: IDS.item, platform: 'x', lane: 'publish-fast' };
    const parsed = PublishQueueMessageSchema.parse(legacyWireMessage);
    expect(parsed.schemaVersion).toBe(PUBLISH_QUEUE_MESSAGE_SCHEMA_VERSION);
    expect(PUBLISH_QUEUE_MESSAGE_SCHEMA_VERSION).toBe(1);
  });

  it('rejects malformed messages', () => {
    expect(
      PublishQueueMessageSchema.safeParse({ itemId: 'item-1', platform: 'facebook', lane: 'publish-fast' })
        .success
    ).toBe(false); // itemId is the queue item UUID
    expect(
      PublishQueueMessageSchema.safeParse({ itemId: IDS.item, platform: 'myspace', lane: 'publish-fast' })
        .success
    ).toBe(false);
    expect(
      PublishQueueMessageSchema.safeParse({ itemId: IDS.item, platform: 'facebook', lane: 'publish-slow' })
        .success
    ).toBe(false);
    expect(
      PublishQueueMessageSchema.safeParse({
        itemId: IDS.item,
        platform: 'facebook',
        lane: 'publish-fast',
        schemaVersion: 0,
      }).success
    ).toBe(false);
    expect(PublishQueueMessageSchema.safeParse(null).success).toBe(false);
    expect(PublishQueueMessageSchema.safeParse({}).success).toBe(false);
  });
});

describe('PublishOutcomeSchema', () => {
  it('accepts published / retry / failed outcomes and round-trips them', () => {
    const published: PublishOutcome = {
      status: 'published',
      externalPostId: 'post-1',
      externalCommentId: 'comment-1',
      detail: { containerId: 'c-1' },
    };
    expect(PublishOutcomeSchema.parse(published)).toEqual(published);

    const retry: PublishOutcome = {
      status: 'retry',
      error: { kind: 'retryable', code: 'rate_limited', message: 'slow down', retryDelaySeconds: 60 },
      retryDelaySeconds: 60,
      targetDestinationStatus: 'rate_limited',
      rateUsagePct: 99.5,
    };
    expect(PublishOutcomeSchema.parse(JSON.parse(JSON.stringify(retry)))).toEqual(retry);

    const failed: PublishOutcome = {
      status: 'failed',
      error: { kind: 'auth', code: '190', subcode: '463', message: 'token expired' },
      targetAccountStatus: 'expired',
    };
    expect(PublishOutcomeSchema.parse(failed)).toEqual(failed);

    // Spec 139 defer outcome: a deferral carries its reason in `error`
    // and its delay in `retryDelaySeconds`; it never advances the
    // item's retry_count at settle time.
    const deferred: PublishOutcome = {
      status: 'deferred',
      error: {
        kind: 'retryable',
        code: 'publishing_limit_reached',
        message: 'This account has reached its publishing limit for now.',
      },
      retryDelaySeconds: 3600,
      detail: { platform: 'instagram', publishingLimit: { usage: 50 } },
    };
    expect(PublishOutcomeSchema.parse(JSON.parse(JSON.stringify(deferred)))).toEqual(deferred);
  });

  it('rejects malformed outcomes', () => {
    expect(PublishOutcomeSchema.safeParse({ status: 'queued' }).success).toBe(false);
    expect(
      PublishOutcomeSchema.safeParse({ status: 'published', rateUsagePct: 101 }).success
    ).toBe(false);
    expect(
      PublishOutcomeSchema.safeParse({
        status: 'failed',
        error: { kind: 'auth', code: 190, message: 'numeric codes are the legacy shape' },
      }).success
    ).toBe(false);
    expect(
      PublishOutcomeSchema.safeParse({ status: 'retry', targetDestinationStatus: 'fb_rate_limited' })
        .success
    ).toBe(false); // legacy page vocabulary, not a destination status
    expect(PublishOutcomeSchema.safeParse(null).success).toBe(false);
  });
});
