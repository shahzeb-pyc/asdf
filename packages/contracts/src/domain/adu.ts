import { z } from 'zod';

/**
 * Auto Download/Upload (ADU) — contracts first.
 *
 * Faithful to the old fbuploadpro ADU surface (list / detail / Add Page /
 * reels queue / failed posts / settings), adapted to the new app:
 * - The ADU unit is NOT a parallel `pages` table. An ADU config links to
 *   one existing unified `destinations` row (a Facebook Page) and adds
 *   source + schedule + sync state on top of it. No destination data is
 *   duplicated into the ADU tables.
 * - There is NO token gate: the old `tokens_balance >= 60` rule and the
 *   global posting-pause switch do not exist in the new app and are not
 *   carried over. There is NO old App ID/Secret + debug_token handling:
 *   publishing uses BYOC credentials + the destination token, exactly
 *   like every other Facebook publish in the new app.
 * - Posting times are stored as HH:mm in the config's own timezone
 *   (the old app stored UTC and converted on read; the user-visible
 *   result is identical and the worker can compare local time directly).
 * - Discovery and download do NOT live in the web app or the worker:
 *   they are the VPS services apps/adu-scraper (yt-dlp + Puppeteer)
 *   and apps/adu-downloader (yt-dlp + aria2 + R2 buffer), exactly
 *   like the old fbuploadpro. The downloader copies each reel to the
 *   R2 buffer (media_object_key, size, content type, SHA-256) and
 *   records the public media_url the Facebook publisher fetches.
 *   No third-party download API is used anywhere in ADU.
 */

export const AduSourcePlatformSchema = z.enum([
  'instagram',
  'youtube',
  'tiktok',
  'facebook',
]);
export type AduSourcePlatform = z.infer<typeof AduSourcePlatformSchema>;

export const ADU_SOURCE_PLATFORMS: AduSourcePlatform[] = [
  'instagram',
  'youtube',
  'tiktok',
  'facebook',
];

export const AduConfigStatusSchema = z.enum([
  'active',
  'inactive',
  'completed',
  'fb_verification_required',
  'invalid_token',
  'fb_rate_limited',
  'page_not_accessible',
  'invalid_username',
  'creator_suspended',
  '2fa_required_on_BM',
  'check_developer_app',
  'account_suspended',
]);
export type AduConfigStatus = z.infer<typeof AduConfigStatusSchema>;

export const AduSyncStatusSchema = z.enum([
  'pending',
  'browser_pending',
  'processing',
  'synced',
  'error',
]);
export type AduSyncStatus = z.infer<typeof AduSyncStatusSchema>;

export const AduReelStatusSchema = z.enum([
  'pending',
  'processing',
  'downloaded',
  'download_failed',
  'posted',
  'skipped',
]);
export type AduReelStatus = z.infer<typeof AduReelStatusSchema>;

export const AduJobStatusSchema = z.enum([
  'pending_publish',
  'publishing',
  'published',
  'failed_to_publish',
  'publish_error',
  'integrity_error',
]);
export type AduJobStatus = z.infer<typeof AduJobStatusSchema>;

/** Old status-filter list, in old order, for the hub filter. */
export const ADU_STATUS_FILTER_OPTIONS = [
  'All Statuses',
  'Active',
  'Inactive',
  'Verification Req.',
  'Rate Limited',
  'Page Not Accessible',
  'Invalid Token',
  'Invalid Username',
  'Creator Suspended',
  'Completed',
  '2FA Req. on BM',
  'Check Dev App',
  'Account Suspended',
] as const;

/** Display badge for a page status, once sync is done. */
export const ADU_PAGE_STATUS_LABELS: Record<AduConfigStatus, string> = {
  active: 'Active posting',
  inactive: 'Posting inactive',
  completed: 'All reels posted',
  fb_verification_required: 'Verification required',
  invalid_token: 'Invalid token',
  fb_rate_limited: 'Rate limited',
  page_not_accessible: 'Page not accessible',
  invalid_username: 'Source disabled',
  creator_suspended: 'Creator suspended',
  '2fa_required_on_BM': 'BM 2FA required',
  check_developer_app: 'Check developer app',
  account_suspended: 'Account suspended',
};

export const ADU_SYNC_STATUS_LABELS: Record<AduSyncStatus, string> = {
  pending: 'Scrape pending',
  browser_pending: 'Scrape pending',
  processing: 'Scraping reels',
  synced: 'Synced',
  error: 'Source not found',
};

/**
 * Badge precedence from the old app: a sync state overrides the page
 * status until the source has synced. Only then does page status show.
 */
export function aduDisplayStatus(
  status: AduConfigStatus,
  syncStatus: AduSyncStatus
): string {
  if (syncStatus === 'error') return 'Source not found';
  if (syncStatus === 'processing') return 'Scraping reels';
  if (syncStatus === 'pending' || syncStatus === 'browser_pending')
    return 'Scrape pending';
  return ADU_PAGE_STATUS_LABELS[status];
}

/** Plain-language alert per status, in the old wording. No alert when active. */
export function aduStatusAlert(
  status: AduConfigStatus,
  syncStatus: AduSyncStatus
): string | null {
  if (syncStatus === 'error')
    return 'The source could not be found. Check the source username in Settings, then try again.';
  if (status === 'active') return null;
  switch (status) {
    case 'inactive':
      return 'Posting is inactive. Activate automation from the header to resume.';
    case 'fb_verification_required':
      return 'Facebook verification is required. Complete verification in the Meta app — do not reconnect the account.';
    case 'fb_rate_limited':
      return 'Automation is paused for about 3 days because of a Facebook rate limit. It resumes automatically.';
    case 'invalid_token':
      return 'The Facebook token is invalid. Reconnect the account in Facebook Accounts.';
    case 'page_not_accessible':
      return 'This page is not accessible. Check the page permissions and reconnect if needed.';
    case 'invalid_username':
      return 'The source is disabled. Change the source in Settings to continue.';
    case 'creator_suspended':
      return 'This source is unavailable after too many download failures. Change the source in Settings, then reactivate.';
    case 'completed':
      return 'All reels have been posted. Update the source in Settings to continue.';
    case '2fa_required_on_BM':
      return 'Two-factor authentication is required on the Business Manager. Complete it, then reactivate.';
    case 'check_developer_app':
      return 'Check the developer app settings for this page, then reactivate.';
    case 'account_suspended':
      return 'The Facebook account is suspended. Resolve it in Facebook, then reactivate.';
    default:
      return null;
  }
}

export function aduSourceLink(
  platform: AduSourcePlatform,
  username: string
): string {
  switch (platform) {
    case 'instagram':
      return `https://www.instagram.com/${username}`;
    case 'youtube':
      return `https://www.youtube.com/@${username}`;
    case 'tiktok':
      return `https://www.tiktok.com/@${username}`;
    case 'facebook':
      return `https://www.facebook.com/${username}`;
  }
}

export function aduSourceIdentity(
  platform: AduSourcePlatform,
  username: string
): string {
  return platform === 'facebook' ? username : `@${username}`;
}

/**
 * Old source-identity sanitisation: strip a leading @ / whitespace, and
 * resolve a full URL to its first path segment. Facebook wins on the
 * `?id=` parameter; people/pages/groups/profile and c/channel/user
 * prefixes are stripped.
 */
export function sanitizeSourceIdentity(
  platform: AduSourcePlatform,
  raw: string
): string {
  let value = raw.trim().replace(/^@+/, '');
  if (!value) return '';
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (platform === 'facebook') {
        const id = url.searchParams.get('id');
        if (id) return id;
      }
      const segments = url.pathname.split('/').filter(Boolean);
      // A prefix segment (channel/, c/, people/, …) is not the identity:
      // the identity is the segment after it.
      const prefixes = ['people', 'pages', 'groups', 'profile', 'c', 'channel', 'user'];
      value =
        segments[0] && prefixes.includes(segments[0].toLowerCase())
          ? (segments[1] ?? '')
          : (segments[0] ?? '');
    }
  } catch {
    // Not a URL — keep the trimmed value below.
  }
  value = value.replace(/^@+/, '');
  for (const prefix of ['people/', 'pages/', 'groups/', 'profile/', 'c/', 'channel/', 'user/']) {
    if (value.toLowerCase().startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }
  return value.replace(/^@+/, '').trim();
}

const PLATFORM_ALIASES: Record<string, AduSourcePlatform> = {
  ig: 'instagram',
  insta: 'instagram',
  instagram: 'instagram',
  yt: 'youtube',
  youtube: 'youtube',
  tt: 'tiktok',
  tiktok: 'tiktok',
  fb: 'facebook',
  facebook: 'facebook',
};

export function resolveAduPlatformAlias(raw: string): AduSourcePlatform | null {
  return PLATFORM_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export interface AduParsedSource {
  platform: AduSourcePlatform;
  username: string;
}

export interface AduBulkPasteResult {
  sources: AduParsedSource[];
  errors: string[];
  warnings: string[];
}

/**
 * Bulk paste, old rules: one source per line, `platform|username`
 * (also `,` or `:` separators; a plain username uses the default
 * platform). Blank and `#`-comment lines are skipped. Over 1,000 lines
 * rejects the whole paste. Invalid platform / empty username is a
 * per-line error; duplicate lines are a warning and are ignored.
 * Assignment to pages (random, empty slots only) is the caller's job.
 */
export function parseAduBulkPaste(
  text: string,
  defaultPlatform: AduSourcePlatform
): AduBulkPasteResult {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
  if (nonEmpty.length > 1000) {
    return {
      sources: [],
      errors: ['Paste is limited to 1,000 lines. The whole paste was rejected.'],
      warnings: [],
    };
  }
  const sources: AduParsedSource[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const line of nonEmpty) {
    const trimmed = line.trim();
    const separator = trimmed.includes('|')
      ? '|'
      : trimmed.includes(',')
        ? ','
        : trimmed.includes(':')
          ? ':'
          : null;
    let platform = defaultPlatform;
    let usernameRaw = trimmed;
    if (separator) {
      const [platformRaw, ...rest] = trimmed.split(separator);
      const resolved = resolveAduPlatformAlias(platformRaw ?? '');
      if (!resolved) {
        errors.push(`Invalid platform in line: ${trimmed}`);
        continue;
      }
      platform = resolved;
      usernameRaw = rest.join(separator);
    }
    const username = sanitizeSourceIdentity(platform, usernameRaw);
    if (!username) {
      errors.push(`Empty username in line: ${trimmed}`);
      continue;
    }
    const key = `${platform}|${username.toLowerCase()}`;
    if (seen.has(key)) {
      warnings.push(`Duplicate source ignored: ${platform}|${username}`);
      continue;
    }
    seen.add(key);
    sources.push({ platform, username });
  }
  return { sources, errors, warnings };
}

export interface AduCsvRow {
  pageName: string;
  platform: AduSourcePlatform;
  username: string;
}

export interface AduCsvResult {
  rows: AduCsvRow[];
  warnings: string[];
}

/** CSV, old rules: max 1,000 rows, headers page_name/source_platform/source_username. */
export function parseAduCsv(text: string): AduCsvResult {
  const rawLines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (rawLines.length === 0) return { rows: [], warnings: ['The CSV file is empty.'] };
  const delimiter = rawLines[0]?.includes(';')
    ? ';'
    : rawLines[0]?.includes('\t')
      ? '\t'
      : ',';
  const header = (rawLines[0] ?? '').split(delimiter).map((h) =>
    h.trim().toLowerCase().replace(/^"|"$/g, '')
  );
  const pageIdx = header.findIndex((h) => h === 'page_name' || h === 'page');
  const platformIdx = header.findIndex((h) => h === 'source_platform' || h === 'platform');
  const sourceIdx = header.findIndex((h) => h === 'source_username' || h === 'source');
  if (pageIdx < 0 || platformIdx < 0 || sourceIdx < 0) {
    return {
      rows: [],
      warnings: ['CSV must have page_name, source_platform and source_username headers.'],
    };
  }
  const dataLines = rawLines.slice(1);
  const warnings: string[] = [];
  if (dataLines.length > 1000) {
    warnings.push('CSV is limited to 1,000 rows. Only the first 1,000 rows were read.');
  }
  const rows: AduCsvRow[] = [];
  const seenPages = new Set<string>();
  for (const line of dataLines.slice(0, 1000)) {
    const cells = line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ''));
    const pageName = (cells[pageIdx] ?? '').trim().replace(/\s+/g, ' ');
    const platform = resolveAduPlatformAlias(cells[platformIdx] ?? '');
    const username = platform
      ? sanitizeSourceIdentity(platform, cells[sourceIdx] ?? '')
      : '';
    if (!pageName || !platform || !username) {
      warnings.push(`Row skipped (invalid platform or empty source): ${line}`);
      continue;
    }
    const key = pageName.toLowerCase();
    if (seenPages.has(key)) {
      warnings.push(`Duplicate page ignored after the first row: ${pageName}`);
      continue;
    }
    seenPages.add(key);
    rows.push({ pageName, platform, username });
  }
  return { rows, warnings };
}

/** HH:mm in 24-hour form. */
export const AduTimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm');

export const AduCreateConfigSchema = z
  .object({
    destinationId: z.string().uuid(),
    sourcePlatform: AduSourcePlatformSchema,
    sourceUsername: z.string().min(1).max(255),
    timezone: z.string().min(1).max(100).default('Asia/Karachi'),
    postsPerDay: z.number().int().min(1).max(12),
    scheduleType: z.enum(['dailyrandom', 'fixed']).default('dailyrandom'),
    postingTimes: z.array(AduTimeOfDaySchema).optional(),
    displayName: z.string().min(1).max(255).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.scheduleType === 'fixed') {
      if (
        !value.postingTimes ||
        value.postingTimes.length !== value.postsPerDay
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Fixed posting requires ${value.postsPerDay} posting times.`,
          path: ['postingTimes'],
        });
      }
    }
  });
export type AduCreateConfig = z.infer<typeof AduCreateConfigSchema>;

export const AduUpdateConfigSchema = z.object({
  status: AduConfigStatusSchema.optional(),
  timezone: z.string().min(1).max(100).optional(),
  postsPerDay: z.number().int().min(0).max(12).optional(),
  scheduleType: z.enum(['dailyrandom', 'fixed']).optional(),
  postingTimes: z.array(AduTimeOfDaySchema).optional(),
  sourcePlatform: AduSourcePlatformSchema.optional(),
  sourceUsername: z.string().min(1).max(255).optional(),
  displayName: z.string().min(1).max(255).optional(),
});
export type AduUpdateConfig = z.infer<typeof AduUpdateConfigSchema>;

/**
 * Bulk / multi-account create: one schedule per config when the
 * caller sets it ("Set separately", old bulkTimingScope ===
 * 'separate'); a per-item schedule takes precedence over the shared
 * fields, exactly like the old bulk validation. Kept in contracts so
 * the route and the tests share one definition of precedence and of
 * the fixed-times error wording.
 */
export const AduBulkItemScheduleSchema = z.object({
  timezone: z.string().min(1).max(100),
  postsPerDay: z.number().int().min(1).max(12),
  postingTimes: z.array(z.string()).optional(),
});
export type AduBulkItemSchedule = z.infer<typeof AduBulkItemScheduleSchema>;

export const AduBulkItemSchema = z.object({
  destinationId: z.string().uuid(),
  sourcePlatform: AduSourcePlatformSchema,
  sourceUsername: z.string().min(1).max(255),
  schedule: AduBulkItemScheduleSchema.optional(),
});
export type AduBulkItem = z.infer<typeof AduBulkItemSchema>;

export const AduBulkCreateSchema = z.object({
  items: z.array(AduBulkItemSchema).min(1).max(1000),
  timezone: z.string().min(1).max(100).default('Asia/Karachi'),
  postsPerDay: z.number().int().min(1).max(12),
  scheduleType: z.enum(['dailyrandom', 'fixed']).default('dailyrandom'),
  postingTimes: z.array(z.string()).optional(),
});
export type AduBulkCreate = z.infer<typeof AduBulkCreateSchema>;

export function resolveAduBulkItemSchedule(
  item: AduBulkItem,
  shared: { timezone: string; postsPerDay: number; postingTimes?: string[] | undefined },
): { timezone: string; postsPerDay: number; postingTimes: string[] | undefined } {
  return {
    timezone: item.schedule?.timezone ?? shared.timezone,
    postsPerDay: item.schedule?.postsPerDay ?? shared.postsPerDay,
    postingTimes: item.schedule?.postingTimes ?? shared.postingTimes,
  };
}

/** Fixed-times validation for a bulk create, in route order: the
 * shared schedule first, then each per-item schedule. Returns the
 * old error wording, or null when the request is valid. */
export function validateAduBulkFixedTimes(data: AduBulkCreate): string | null {
  if (data.scheduleType !== 'fixed') return null;
  if (!data.postingTimes || data.postingTimes.length !== data.postsPerDay) {
    return `Fixed posting requires ${data.postsPerDay} posting times.`;
  }
  for (const item of data.items) {
    if (!item.schedule) continue;
    if (
      !item.schedule.postingTimes ||
      item.schedule.postingTimes.length !== item.schedule.postsPerDay ||
      item.schedule.postingTimes.some((t) => !String(t ?? '').trim())
    ) {
      return `Fixed posting requires ${item.schedule.postsPerDay} posting times.`;
    }
  }
  return null;
}

/**
 * Daily-random times: balanced across the day. The old note promises a
 * minimum 5-hour gap; that is only possible for up to 4 posts a day,
 * so above 4 the gap is the largest even spread the day allows.
 * Times are sorted, unique, and returned as HH:mm.
 */
export function generateDailyRandomTimes(postsPerDay: number): string[] {
  if (postsPerDay <= 0) return [];
  const gapHours = postsPerDay <= 4 ? 5 : 24 / postsPerDay;
  const startHour = Math.floor(Math.random() * 4);
  const times: string[] = [];
  for (let i = 0; i < postsPerDay; i++) {
    const totalMinutes = Math.round(
      (startHour + i * gapHours) * 60 + Math.random() * 30
    );
    const minutes = ((totalMinutes % 1440) + 1440) % 1440;
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    times.push(`${hh}:${mm}`);
  }
  // localeCompare sort (Sonar S2871): every time here is a zero-padded
  // HH:mm string, so the first differing character between any two
  // distinct times is always a digit, and digit order is the same in
  // every locale — the comparison is deterministic, not locale art.
  return [...new Set(times)].sort((a, b) => a.localeCompare(b));
}

/** Local HH:mm for a timezone, used by schedule intake. */
export function localTimeInTimezone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone,
    }).formatToParts(date);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
    // Intl can report 24 for midnight in some runtimes.
    return `${hour === '24' ? '00' : hour}:${minute}`;
  } catch {
    return '00:00';
  }
}

export const AduConfigRowSchema = z
  .object({
    id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    destination_id: z.string().uuid(),
    source_platform: AduSourcePlatformSchema,
    source_username: z.string(),
    timezone: z.string(),
    posts_per_day: z.number().int(),
    schedule_type: z.enum(['dailyrandom', 'fixed']),
    posting_times: z.array(z.string()),
    status: AduConfigStatusSchema,
    sync_status: AduSyncStatusSchema,
    followers_count: z.number().int(),
    followers_gained: z.number().int(),
    display_name: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();
export type AduConfigRow = z.infer<typeof AduConfigRowSchema>;

export const AduReelRowSchema = z
  .object({
    id: z.string().uuid(),
    config_id: z.string().uuid(),
    source_reel_id: z.string(),
    caption: z.string().nullable(),
    media_url: z.string().nullable(),
    media_object_key: z.string().nullable(),
    media_size_bytes: z.number().int().nullable().optional(),
    media_content_type: z.string().nullable().optional(),
    media_sha256: z.string().nullable(),
    status: AduReelStatusSchema,
    download_retries: z.number().int(),
    downloaded_at: z.string().nullable(),
    created_at: z.string(),
  })
  .passthrough();
export type AduReelRow = z.infer<typeof AduReelRowSchema>;

export const AduJobRowSchema = z
  .object({
    id: z.string().uuid(),
    config_id: z.string().uuid(),
    reel_id: z.string().uuid(),
    schedule_slot_at: z.string().nullable(),
    status: AduJobStatusSchema,
    publish_retries: z.number().int(),
    graph_post_id: z.string().nullable(),
    last_error_code: z.string().nullable(),
    last_error_message: z.string().nullable(),
    published_at: z.string().nullable(),
    created_at: z.string(),
  })
  .passthrough();
export type AduJobRow = z.infer<typeof AduJobRowSchema>;

/** Pipeline constants, old values. */
export const ADU_BUFFER_DAYS = 1;
export const ADU_MAX_DOWNLOAD_RETRIES = 3;
export const ADU_MAX_PUBLISH_RETRIES = 5;
export const ADU_SKIP_FAILED_24H = 10;
export const ADU_SUSPEND_FAILED_ALL_TIME = 50;
export const ADU_STALE_PUBLISHING_SECONDS = 300;
