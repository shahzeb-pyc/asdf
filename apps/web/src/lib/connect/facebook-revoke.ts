/**
 * Facebook-side authorization revocation.
 *
 * DELETE /me/permissions with the user's access token revokes the
 * app's authorization for that user. Best-effort by design: it
 * returns false (never throws) on any Graph error or network
 * failure. The caller attempts it only when the token is plausibly
 * still usable, logs loudly on failure, and always deletes the
 * account row regardless — disconnect is the safety action, and
 * blocking it would strand the very token the user wants gone.
 * A revoked token is dead either way; a failed revoke means the
 * authorization may still be live at Facebook until it expires,
 * but the token itself is deleted with the account, so it can
 * never be used from this app again — and the user is never asked
 * to finish the removal in Facebook Settings.
 */
const GRAPH_PERMISSIONS_URL =
  'https://graph.facebook.com/v26.0/me/permissions';

export async function revokeFacebookAuthorization(
  userAccessToken: string
): Promise<boolean> {
  try {
    const response = await fetch(GRAPH_PERMISSIONS_URL, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${userAccessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
