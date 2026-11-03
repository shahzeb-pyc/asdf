/**
 * Minimal PostgREST RPC client for the ADU download RPCs. The Worker uses
 * the Supabase service-role key (the RPCs are EXECUTE-restricted to
 * service_role, exactly like the VPS downloader) and fails loud on any
 * unexpected response shape — a bad row is never processed as if valid.
 */

import type { FetchImpl } from './tikwm.js';

export interface ClaimedReel {
  reelId: string;
  configId: string;
  sourcePlatform: string;
  sourceUsername: string;
  sourceReelId: string;
}

export interface MarkDownloadedArgs {
  reelId: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  sha256: string;
  caption: string;
  mediaUrl: string;
}

function truncate(text: string, limit = 500): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}... [truncated]`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Strip every trailing `/` from a URL prefix, without a regular expression:
 * the naive `/\/+$/` form is flagged as super-linear backtracking (Sonar
 * typescript:S8786), while this scan is linear and preserves the exact
 * semantics (all trailing slashes removed, interior slashes untouched).
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end--;
  }
  return value.slice(0, end);
}

export class SupabaseRpc {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly fetchImpl: FetchImpl;

  constructor(supabaseUrl: string, serviceRoleKey: string, fetchImpl: FetchImpl = fetch) {
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error('SupabaseRpc: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }
    this.baseUrl = stripTrailingSlashes(supabaseUrl);
    this.serviceKey = serviceRoleKey;
    this.fetchImpl = fetchImpl;
  }

  private async callRpc<T>(fn: string, params: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: this.serviceKey,
          Authorization: `Bearer ${this.serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });
    } catch (err) {
      throw new Error(`Supabase RPC ${fn} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = truncate(await res.text());
      } catch {
        detail = '';
      }
      throw new Error(`Supabase RPC ${fn} failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error(`Supabase RPC ${fn} returned unparsable JSON`);
    }
  }

  /** Platform-agnostic stale reset (40 min default, same as the VPS downloader). */
  async resetStaleDownloads(staleMinutes = 40): Promise<number> {
    const result = await this.callRpc<unknown>('reset_stale_adu_reel_downloads', {
      p_stale_minutes: staleMinutes,
    });
    if (typeof result !== 'number') {
      throw new Error('reset_stale_adu_reel_downloads returned a non-integer');
    }
    return result;
  }

  /**
   * Claim TikTok rows ONLY. The function name is the exclusivity
   * mechanism: this client never calls the generic or non-TikTok claim.
   * Any row whose platform is not 'tiktok' is refused, not processed.
   */
  async claimTikTokDownloads(limit: number): Promise<ClaimedReel[]> {
    const rows = await this.callRpc<unknown[]>('claim_tiktok_buffer_downloads', {
      p_limit: limit,
    });
    if (!Array.isArray(rows)) {
      throw new Error('claim_tiktok_buffer_downloads returned a non-array');
    }
    return rows.map((row, index) => {
      if (typeof row !== 'object' || row === null) {
        throw new Error(`claim_tiktok_buffer_downloads row ${index} is not an object`);
      }
      const r = row as Record<string, unknown>;
      if (
        !isNonEmptyString(r.reel_id) ||
        !isNonEmptyString(r.config_id) ||
        !isNonEmptyString(r.source_platform) ||
        !isNonEmptyString(r.source_username) ||
        !isNonEmptyString(r.source_reel_id)
      ) {
        throw new Error(`claim_tiktok_buffer_downloads row ${index} has an invalid shape`);
      }
      if (r.source_platform !== 'tiktok') {
        throw new Error(
          `claim_tiktok_buffer_downloads returned a non-TikTok row (platform: ${String(r.source_platform)}); refusing to process it`,
        );
      }
      return {
        reelId: r.reel_id,
        configId: r.config_id,
        sourcePlatform: r.source_platform,
        sourceUsername: r.source_username,
        sourceReelId: r.source_reel_id,
      };
    });
  }

  async markDownloaded(args: MarkDownloadedArgs): Promise<void> {
    await this.callRpc<void>('mark_adu_reel_downloaded', {
      p_reel_id: args.reelId,
      p_media_object_key: args.objectKey,
      p_media_size_bytes: args.sizeBytes,
      p_media_content_type: args.contentType,
      p_media_sha256: args.sha256,
      p_reel_caption: args.caption,
      p_media_url: args.mediaUrl,
    });
  }

  async markDownloadFailed(reelId: string): Promise<void> {
    await this.callRpc<void>('mark_adu_reel_download_failed', { p_reel_id: reelId });
  }
}
