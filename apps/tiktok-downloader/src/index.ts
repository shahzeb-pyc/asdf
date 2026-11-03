/**
 * Cloudflare Worker: TikTok ADU downloader.
 *
 * Cron-only. Every minute it claims TikTok buffer downloads, resolves each
 * reel through the tikwm HD API (the old service's method), streams the
 * bytes straight to the shared ADU R2 buffer, and settles with the
 * existing download RPCs. It never touches other platforms' rows.
 *
 * Missing secrets fail the tick loudly (the next minute retries); they
 * are provided by the deploy workflow, never committed here.
 */

import { runDownloadTick, type R2BucketLike } from './pipeline.js';
import { SupabaseRpc } from './supabase.js';

export interface Env {
  ENVIRONMENT?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  R2_PUBLIC_URL?: string;
  ADU_BUFFER: R2Bucket;
}

function requireEnv(env: Env): {
  supabaseUrl: string;
  serviceKey: string;
  r2PublicUrl: string;
} {
  const missing: string[] = [];
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!env.R2_PUBLIC_URL) missing.push('R2_PUBLIC_URL');
  if (missing.length > 0) {
    throw new Error(`tiktok-downloader: missing required secrets: ${missing.join(', ')}`);
  }
  return {
    supabaseUrl: env.SUPABASE_URL as string,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY as string,
    r2PublicUrl: env.R2_PUBLIC_URL as string,
  };
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const { supabaseUrl, serviceKey, r2PublicUrl } = requireEnv(env);
    const r2: R2BucketLike = env.ADU_BUFFER;
    const run = runDownloadTick({
      supabase: new SupabaseRpc(supabaseUrl, serviceKey),
      r2,
      r2PublicUrl,
      fetchImpl: fetch,
    });
    if (typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(run);
    }
    await run;
  },

  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },
};
