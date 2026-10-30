/**
 * Audit S3 — worker-side token-key resolution with the web's
 * production fail-closed rules.
 *
 * The worker used to pass the raw env string straight to
 * decrypt/encrypt, so a production worker whose
 * TOKEN_ENCRYPTION_KEY was (mis)set to the publicly known dev
 * fallback key would silently decrypt and encrypt real tokens
 * with it — while the web app refuses to start under the same
 * value. The worker's production signal is ENVIRONMENT, the
 * contracts rule reads NODE_ENV, so this resolver bridges the
 * two: ENVIRONMENT='production' gets the production rules
 * (missing key throws, dev fallback key throws), exactly like
 * web. Every worker entry that touches tokens resolves through
 * here — the refresh cycle, the queue consumers, and the health
 * config check — instead of reading the raw env value.
 */
import { getTokenEncryptionKey } from '@fbuploadpro/contracts';

export function resolveWorkerMasterKey(env: {
  TOKEN_ENCRYPTION_KEY?: string;
  ENVIRONMENT?: string;
}): string {
  return getTokenEncryptionKey({
    TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
    NODE_ENV: env.ENVIRONMENT,
  });
}
