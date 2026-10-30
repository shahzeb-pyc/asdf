/**
 * Facebook-side authorization revocation (audit BG10).
 *
 * DELETE /me/permissions with the user's access token revokes the
 * app's authorization for that user — disconnecting only
 * app-locally leaves the authorization alive in the user's
 * Facebook settings, so "disconnected" would be a lie without
 * this call. Best-effort by design: it returns false (never
 * throws) on any Graph error or network failure, and the caller
 * logs loudly and surfaces the outcome instead of blocking the
 * local disconnect on it — disconnect is the safety action, and
 * blocking it would strand the very token the user wants gone.
 * A revoked token is dead either way; a failed revoke means the
 * token may still be live at Facebook until it expires, which is
 * why the caller must surface facebookRevoked=false.
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
