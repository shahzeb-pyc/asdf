/**
 * Privacy Policy URL for a workspace.
 *
 * The privacy page is public on every subdomain, so the URL shown to a
 * user (and pasted into Meta's Privacy Policy URL field for the Facebook
 * app) is the workspace-subdomain form:
 *   https://<workspace>.fbuploadpro.com/privacy
 *
 * Built from the workspace subdomain + the configured root domain, never
 * hardcoded to one workspace. With no subdomain, falls back to the
 * relative /privacy path (used on the app/apex host itself).
 */
export function buildPrivacyPolicyUrl(
  subdomain: string | null | undefined,
  rootDomain: string = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'fbuploadpro.com'
): string {
  const cleanSubdomain = (subdomain || '').trim().toLowerCase();
  if (!cleanSubdomain) return '/privacy';

  const rawRoot = (rootDomain || 'fbuploadpro.com').trim().toLowerCase();
  const [cleanRoot, port] = rawRoot.split(':');
  if (!cleanRoot) return '/privacy';

  const isLocal = cleanRoot.includes('localhost') || cleanRoot.includes('127.0.0.1');
  const protocol = isLocal ? 'http' : 'https';
  const portSuffix = port ? `:${port}` : '';
  return `${protocol}://${cleanSubdomain}.${cleanRoot}${portSuffix}/privacy`;
}
