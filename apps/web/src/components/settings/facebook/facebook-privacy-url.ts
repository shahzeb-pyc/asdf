/**
 * Privacy Policy URL for the Facebook App tab (2026-10-25).
 *
 * Meta's Privacy Policy URL field needs the workspace's public privacy
 * address: https://<workspace-subdomain>.<root-domain>/privacy. The
 * URL is built from the current workspace subdomain plus
 * NEXT_PUBLIC_ROOT_DOMAIN — never hard-coded to one workspace, so the
 * row shows the right address on every workspace. The privacy page
 * itself is built separately (its own branch, merged in later); this
 * helper only builds the address the Facebook panel shows and copies.
 */

export function getWorkspacePrivacyUrl(
  subdomain: string,
  rootDomain: string = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'fbuploadpro.com'
): string {
  const cleanRoot = rootDomain.replace(/\/+$/, '');
  return `https://${subdomain}.${cleanRoot}/privacy`;
}
