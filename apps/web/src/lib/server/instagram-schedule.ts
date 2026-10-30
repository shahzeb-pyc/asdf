import {
  canAddInstagramSchedule,
  IG_SCHEDULE_DEFAULT_SLOT_KINDS,
  IG_SCHEDULE_METADATA_FLAG,
  IG_SCHEDULE_PAUSED_FLAG,
  isInstagramScheduleSlotKind,
  validateInstagramScheduleSlots,
} from '@fbuploadpro/contracts';

import type { InstagramScheduleStatus } from '@/lib/api/schemas/instagram-schedule';

/**
 * Shared server helpers for the Instagram Schedule routes. These are
 * the Instagram-only counterparts of the Facebook Pages wire helpers:
 * the same unified tables, the same tenant scoping, but the Schedule
 * membership rule (metadata flag) and the Instagram format rules.
 *
 * A destination is "scheduled" exactly when its metadata carries
 * `scheduled = true`. That flag is the whole membership model — there
 * is no schedule table, and deleting the flag (Remove from Schedule)
 * never deletes the destination row or the connected account.
 */

/** Raw destination row as read from either data path. */
export interface InstagramScheduleDestinationRow {
  id: string;
  account_id?: string | null;
  accountId?: string | null;
  timezone?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
  name?: string | null;
  handle?: string | null;
  avatar_url?: string | null;
  avatarUrl?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
}

/** Raw connected-account row as read from either data path. */
export interface InstagramScheduleAccountRow {
  id: string;
  display_name?: string | null;
  displayName?: string | null;
  avatar_url?: string | null;
  avatarUrl?: string | null;
  status?: string | null;
  token_expires_at?: string | Date | null;
  tokenExpiresAt?: string | Date | null;
  external_account_id?: string | null;
  externalAccountId?: string | null;
}

/** True when the destination's metadata marks it as scheduled. */
export function isScheduledDestination(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  return metadata?.[IG_SCHEDULE_METADATA_FLAG] === true;
}

/** True when the destination's metadata marks it as paused. */
export function isPausedDestination(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  return metadata?.[IG_SCHEDULE_PAUSED_FLAG] === 'paused';
}

/**
 * Schedule status from destination + account state, in priority order:
 * paused wins (the user chose it), then an expired account, then a
 * disconnected destination, then active. The account's stored status
 * and a past token both mean expired, mirroring the Accounts list.
 */
export function scheduleStatusFor(
  destination: Pick<InstagramScheduleDestinationRow, 'status' | 'metadata'>,
  account: Pick<
    InstagramScheduleAccountRow,
    'status' | 'token_expires_at' | 'tokenExpiresAt'
  > | null
): InstagramScheduleStatus {
  if (isPausedDestination(destination.metadata)) return 'paused';
  const accountStatus = account?.status ?? null;
  const rawExpires = account?.token_expires_at ?? account?.tokenExpiresAt;
  const expiresAt = rawExpires ? new Date(rawExpires).getTime() : null;
  if (
    accountStatus === 'expired' ||
    (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt < Date.now())
  ) {
    return 'expired';
  }
  if (destination.status === 'disconnected') return 'disconnected';
  return 'active';
}

/** True when the account may be added to Schedule (active, live token). */
export function isAddableInstagramAccount(
  account: Pick<
    InstagramScheduleAccountRow,
    'status' | 'token_expires_at' | 'tokenExpiresAt'
  >
): boolean {
  if (account.status !== 'active') return false;
  const rawExpires = account.token_expires_at ?? account.tokenExpiresAt;
  if (!rawExpires) return true;
  const expiresAt = new Date(rawExpires).getTime();
  return Number.isFinite(expiresAt) && expiresAt >= Date.now();
}

/** Validates an IANA timezone name without depending on a registry. */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone || timezone.length > 100) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalises slot formats to the Instagram set: caller-supplied formats
 * are validated (text/story and anything unknown are rejected with a
 * plain message), and an omitted list becomes the default Photo/Reel/
 * Carousel set. Returns the formats or a plain-language error.
 */
export function normalizeScheduleSlotFormats(
  formats: readonly string[] | undefined
): { formats: string[] } | { error: string } {
  if (formats === undefined) {
    return { formats: [...IG_SCHEDULE_DEFAULT_SLOT_KINDS] };
  }
  for (const format of formats) {
    if (!isInstagramScheduleSlotKind(format)) {
      return {
        error: `Posting format "${format}" is not supported for Instagram scheduling.`,
      };
    }
  }
  return { formats: [...formats] };
}

/** Validates a posting-times batch with the contracts rule (§3). */
export function validateSchedulePostingTimes(
  postingTimes: ReadonlyArray<{ time: string; formats?: string[] | undefined }>
): string | null {
  return validateInstagramScheduleSlots(postingTimes);
}

/** Cap check for adding another scheduled account (unlimited while null). */
export function checkScheduleCap(currentCount: number) {
  return canAddInstagramSchedule(currentCount);
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function isoField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return new Date().toISOString();
}

/**
 * Maps a destination + account + counts into the list/detail wire item.
 * Followers are deliberately absent: no Instagram follower read exists,
 * so the item never carries a follower number.
 */
export function mapDestinationToScheduleItem(
  destination: InstagramScheduleDestinationRow,
  account: InstagramScheduleAccountRow | null,
  slotCount: number,
  counts: { queued: number; posted: number; failed: number }
) {
  const metadata = destination.metadata ?? null;
  return {
    id: destination.id,
    accountId:
      destination.account_id ?? destination.accountId ?? account?.id ?? '',
    accountDisplayName:
      account?.display_name ??
      account?.displayName ??
      destination.name ??
      'Instagram account',
    accountAvatarUrl:
      account?.avatar_url ?? account?.avatarUrl ?? destination.avatar_url ?? destination.avatarUrl ?? null,
    handle: destination.handle ?? null,
    accountType:
      (metadata?.account_type as string | undefined) ??
      (metadata?.accountType as string | undefined) ??
      null,
    status: scheduleStatusFor(destination, account),
    timezone: stringField(destination.timezone, 'UTC'),
    slotCount,
    counts,
    createdAt: isoField(destination.created_at ?? destination.createdAt),
    updatedAt: isoField(destination.updated_at ?? destination.updatedAt),
  };
}

/** Extracts a metadata object from a row, tolerating string JSON. */
export function parseDestinationMetadata(
  raw: unknown
): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return null;
}
