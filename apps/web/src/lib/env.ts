/**
 * Boot-time environment validation (spec 139).
 *
 * Misconfigured deploys used to boot green and then fail route-by-route
 * the first time a handler touched a missing variable. This module is
 * the fail-fast gate: `register()` in src/instrumentation.ts calls
 * `validateEnv()` once at server boot.
 *
 * - Production (`NODE_ENV=production`): a missing/empty required
 *   variable throws, naming the missing variables (names only — values
 *   are never read into the message, logged, or returned).
 * - Every other environment: the same names are surfaced via
 *   `console.warn` and boot continues, so local development with a
 *   partial .env still works.
 *
 * The required set is the union of the variables the web app's server
 * code cannot run without (derived from a grep of process.env across
 * apps/web/src): Supabase (public + service role), session/token
 * secrets, Upstash rate limiting, R2 media storage, public app/tenant
 * domains, and the PostHog server key (spec 118 wiring — production
 * error reporting is silently dead without it).
 */
import { z } from 'zod';

/**
 * Optional environment variable names: recognised by the app but not
 * required at boot. The Backblaze B2 storage vars (spec 259) are
 * optional — the app runs R2-only until they are supplied in phase 2,
 * and B2-only once R2 is retired. Presence-only: no format validation
 * here; the owning module (lib/storage.ts) validates shape.
 */
export const OPTIONAL_ENV_VARS = [
  'B2_APPLICATION_KEY_ID',
  'B2_APPLICATION_KEY',
  'B2_BUCKET_NAME',
  'B2_REGION',
] as const;

export type OptionalEnvVar = (typeof OPTIONAL_ENV_VARS)[number];

/** Required environment variable names, in documentation order. */
export const REQUIRED_ENV_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SESSION_SECRET',
  'TOKEN_ENCRYPTION_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_ROOT_DOMAIN',
  'POSTHOG_KEY',
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

const nonEmpty = z.string().trim().min(1);

/**
 * Presence-only schema: every required variable must be a non-empty
 * string. Format validation stays with the owning modules (e.g. the
 * TOKEN_ENCRYPTION_KEY shape check in @fbuploadpro/contracts, the R2
 * config schema in lib/storage.ts) — this gate answers exactly one
 * question: is it set?
 */
const requiredEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: nonEmpty,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  SESSION_SECRET: nonEmpty,
  TOKEN_ENCRYPTION_KEY: nonEmpty,
  UPSTASH_REDIS_REST_URL: nonEmpty,
  UPSTASH_REDIS_REST_TOKEN: nonEmpty,
  R2_ACCOUNT_ID: nonEmpty,
  R2_ACCESS_KEY_ID: nonEmpty,
  R2_SECRET_ACCESS_KEY: nonEmpty,
  R2_BUCKET_NAME: nonEmpty,
  NEXT_PUBLIC_APP_URL: nonEmpty,
  NEXT_PUBLIC_ROOT_DOMAIN: nonEmpty,
  POSTHOG_KEY: nonEmpty,
});

/**
 * Names of the required variables that are missing or empty in `env`,
 * in REQUIRED_ENV_VARS order. Pure: reads nothing global, so tests can
 * pass any snapshot.
 */
export function findMissingEnvVars(
  env: Record<string, string | undefined>
): RequiredEnvVar[] {
  const result = requiredEnvSchema.safeParse(env);
  if (result.success) return [];
  const failed = new Set(
    result.error.issues.map((issue) => String(issue.path[0]))
  );
  return REQUIRED_ENV_VARS.filter((name) => failed.has(name));
}

export interface EnvValidationResult {
  /** Required variables that are missing/empty (names only). */
  missing: RequiredEnvVar[];
}

/**
 * Validate `env` (defaults to process.env) at boot.
 *
 * Throws in production when anything required is missing — the error
 * names the missing variables only, never their (absent) values or any
 * other variable's value. In non-production it warns with the same
 * names and returns the result so boot can continue.
 */
export function validateEnv(
  env: Record<string, string | undefined> = process.env,
  options?: { nodeEnv?: string | undefined }
): EnvValidationResult {
  const missing = findMissingEnvVars(env);
  if (missing.length === 0) return { missing };

  const message =
    `Missing required environment variables: ${missing.join(', ')}. ` +
    'Set them in the deployment environment (see apps/web/.env.example) before starting the server.';
  const nodeEnv = options?.nodeEnv ?? env.NODE_ENV;
  if (nodeEnv === 'production') {
    throw new Error(`[env] ${message}`);
  }
  console.warn(`[env] ${message} Continuing because NODE_ENV is not production.`);
  return { missing };
}
