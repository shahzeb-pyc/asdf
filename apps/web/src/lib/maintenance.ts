/**
 * Maintenance mode (spec 209).
 *
 * The flag is the `MAINTENANCE_MODE` Doppler secret (server-only,
 * no NEXT_PUBLIC_ prefix), set in Doppler `prd`. Value `true`
 * (exact, lowercase) = maintenance on; unset, empty, or anything
 * else = off. This PR builds the mechanism only — it does not turn
 * maintenance on by itself; the secret turns it on. Turning off is
 * the secret to `false` + a redeploy (env changes need a deploy to
 * take effect).
 *
 * Read fresh on every call — NOT a module-level const captured at
 * import — so tests can flip it by setting process.env, and so a
 * redeploy with a new secret value takes effect without a code
 * change.
 *
 * NOTE: an empty commit does NOT redeploy. Vercel skips empty
 * merges as "Not affected" and keeps serving the old deploy with
 * the old secret value, so flipping this flag off requires a real
 * file change (like this comment) to force a fresh build.
 *
 * Enabled 2026-11-22 during the Supabase Disk IO outage (redeploy
 * trigger so the MAINTENANCE_MODE=true secret takes effect).
 *
 * Disabled 2026-11-23 after the Supabase account move to newdb
 * (chbtrophjeavksryvglv) completed and verified — redeploy trigger
 * so the MAINTENANCE_MODE=false secret takes effect.
 */
export function isMaintenanceMode(): boolean {
  return process.env.MAINTENANCE_MODE === 'true';
}

/**
 * Paths the maintenance rewrite never applies to: the maintenance
 * page itself, API routes, /_next/* internals, and static assets.
 * The middleware matcher already excludes /_next/* internals and
 * most static files before the middleware runs; the checks here
 * cover what can still reach it (favicon, robots, sitemap, icons,
 * /api).
 */
export function isMaintenanceExemptPath(pathname: string): boolean {
  if (pathname === '/maintenance') return true;
  if (pathname === '/api' || pathname.startsWith('/api/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    pathname === '/icon' ||
    pathname === '/apple-icon' ||
    pathname.endsWith('.ico')
  ) {
    return true;
  }
  return false;
}
