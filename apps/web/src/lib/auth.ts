import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import {
  getSessionSecret,
  verifySessionToken,
  type SessionPayload,
  type UserRole,
} from '@fbuploadpro/contracts';

export interface AuthenticatedUserContext {
  userId: string;
  email: string;
  role: UserRole;
  subdomain: string;
  allowedSubdomains?: string[] | undefined;
  // S3: id of the token's active-subdomain workspace, when the token
  // carries the claim (user role, minted post-S3). Absent for old
  // tokens and for admin/seller sessions.
  workspaceId?: string | undefined;
}

export async function getServerSessionContext(req?: NextRequest): Promise<AuthenticatedUserContext | null> {
  let token = req?.cookies?.get('fbup_session')?.value;
  if (!token) {
    try {
      const cookieStore = await cookies();
      token = cookieStore?.get('fbup_session')?.value;
    } catch {
      token = undefined;
    }
  }
  if (!token) {
    return null;
  }

  const secret = getSessionSecret();
  try {
    const session: SessionPayload = await verifySessionToken(token, secret);
    return {
      userId: session.userId,
      email: session.email,
      role: session.role,
      subdomain: session.subdomain,
      ...(session.allowedSubdomains ? { allowedSubdomains: session.allowedSubdomains } : {}),
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    };
  } catch {
    return null;
  }
}
