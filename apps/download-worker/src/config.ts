/**
 * Download worker configuration (spec 149). Every value comes from the
 * environment — secrets are never in the repo and never printed. A
 * missing required value fails boot loudly with the missing NAMES
 * (not values), so a misconfigured service is visible, never silently
 * idle.
 */

export interface DownloadWorkerConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2BucketName: string;
  r2PublicUrl: string;
  workerId: string;
  pollIntervalMs: number;
  maxConcurrentJobs: number;
  extractorApiUrl: string | null;
}

function optionalInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DownloadWorkerConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const value = env[name];
    if (!value) missing.push(name);
    return value ?? '';
  };

  const config: DownloadWorkerConfig = {
    supabaseUrl: need('SUPABASE_URL'),
    supabaseServiceRoleKey: need('SUPABASE_SERVICE_ROLE_KEY'),
    r2AccountId: need('R2_ACCOUNT_ID'),
    r2AccessKeyId: need('R2_ACCESS_KEY_ID'),
    r2SecretAccessKey: need('R2_SECRET_ACCESS_KEY'),
    r2BucketName: need('R2_BUCKET_NAME'),
    r2PublicUrl: need('R2_PUBLIC_URL'),
    workerId:
      env['DOWNLOAD_WORKER_ID'] ??
      `download-worker-${process.pid}`,
    pollIntervalMs: optionalInt(env, 'DOWNLOAD_WORKER_POLL_INTERVAL_MS', 5000),
    maxConcurrentJobs: optionalInt(env, 'DOWNLOAD_WORKER_MAX_CONCURRENT_JOBS', 12),
    extractorApiUrl: env['DOWNLOADER_EXTRACTOR_API_URL'] ?? null,
  };

  // Fail here with missing NAMES only, never values.
  if (missing.length > 0) {
    throw new Error(
      `Download worker misconfigured: missing required environment variables: ${missing.join(', ')}`
    );
  }
  return config;
}
