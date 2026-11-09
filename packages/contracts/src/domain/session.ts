import { z } from 'zod';
import { SubdomainSchema, UserRoleSchema, UserStatusSchema } from './user.js';
import { GmailSchema } from './auth.js';
import { DomainError, DomainErrorCode } from '../errors/domain-error.js';

export const SessionHeaderSchema = z.object({
  alg: z.literal('HS256'),
  typ: z.literal('JWT'),
});

export type SessionHeader = z.infer<typeof SessionHeaderSchema>;

export const SessionPayloadSchema = z.object({
  userId: z.string().uuid(),
  email: GmailSchema,
  name: z.string().max(100).nullable().optional(),
  subdomain: SubdomainSchema,
  // S3: id of the workspace named by `subdomain`, for role === 'user'
  // only. Optional so pre-S3 tokens (no claim) keep verifying through
  // the 30-day rollout tail via the DB fallback.
  workspaceId: z.string().uuid().optional(),
  allowedSubdomains: z.array(SubdomainSchema).optional(),
  role: UserRoleSchema,
  status: UserStatusSchema,
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
});

export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  const base64 = btoa(binary);
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/={1,2}$/, '');
}

function base64UrlDecode(str: string): Uint8Array<ArrayBuffer> {
  let base64 = str.replaceAll('-', '+').replaceAll('_', '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signSessionToken(
  payload: SessionPayload | (Omit<SessionPayload, 'iat' | 'exp'> & { iat?: number; exp?: number }),
  secret: string,
  expiresInSeconds: number = 86400 * 30 // 30 days (2,592,000s) matching fbup_session cookie maxAge
): Promise<string> {
  if (!secret || secret.length < 32) {
    throw new DomainError(
      DomainErrorCode.VALIDATION_FAILED,
      'Session signing secret must be at least 32 characters long'
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const fullPayload: SessionPayload = {
    userId: payload.userId,
    email: payload.email,
    name: payload.name ?? null,
    subdomain: payload.subdomain,
    ...(payload.workspaceId ? { workspaceId: payload.workspaceId } : {}),
    ...(payload.allowedSubdomains ? { allowedSubdomains: payload.allowedSubdomains } : {}),
    role: payload.role,
    status: payload.status,
    iat: payload.iat ?? now,
    exp: payload.exp ?? now + expiresInSeconds,
  };

  const parsed = SessionPayloadSchema.safeParse(fullPayload);
  if (!parsed.success) {
    throw new DomainError(
      DomainErrorCode.VALIDATION_FAILED,
      `Invalid session payload: ${parsed.error.message}`
    );
  }

  const header = { alg: 'HS256', typ: 'JWT' };
  const encoder = new TextEncoder();
  const headerPart = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadPart = base64UrlEncode(encoder.encode(JSON.stringify(parsed.data)));
  const signingInput = `${headerPart}.${payloadPart}`;

  const key = await getHmacKey(secret);
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signingInput)
  );

  const signaturePart = base64UrlEncode(new Uint8Array(signatureBuffer));
  return `${signingInput}.${signaturePart}`;
}

export async function verifySessionToken(
  token: string,
  secret: string
): Promise<SessionPayload> {
  if (!token || typeof token !== 'string') {
    throw new DomainError(DomainErrorCode.UNAUTHORIZED, 'Session token is missing or invalid');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new DomainError(DomainErrorCode.UNAUTHORIZED, 'Malformed session token structure');
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) {
    throw new DomainError(DomainErrorCode.UNAUTHORIZED, 'Malformed session token parts');
  }

  let headerJson: unknown;
  try {
    const headerBytes = base64UrlDecode(headerPart);
    const decodedHeaderText = new TextDecoder().decode(headerBytes);
    headerJson = JSON.parse(decodedHeaderText);
  } catch {
    throw new DomainError(DomainErrorCode.UNAUTHORIZED, 'Invalid session token header JSON');
  }

  if (
    typeof headerJson !== 'object' ||
    headerJson === null ||
    !('alg' in headerJson) ||
    (headerJson as { alg?: unknown }).alg !== 'HS256'
  ) {
    throw new DomainError(
      DomainErrorCode.UNAUTHORIZED,
      'Unsupported or missing algorithm in session token header'
    );
  }

  if (
    !('typ' in headerJson) ||
    (headerJson as { typ?: unknown }).typ !== 'JWT'
  ) {
    throw new DomainError(DomainErrorCode.UNAUTHORIZED, 'Invalid session token header type');
  }

  const headerParseResult = SessionHeaderSchema.safeParse(headerJson);
  if (!headerParseResult.success) {
    throw new DomainError(
      DomainErrorCode.UNAUTHORIZED,
      `Corrupted session header schema: ${headerParseResult.error.message}`
    );
  }

  const encoder = new TextEncoder();
  const signingInput = `${headerPart}.${payloadPart}`;
  const key = await getHmacKey(secret);

  let signatureBytes: Uint8Array<ArrayBuffer>;
  try {
    signatureBytes = base64UrlDecode(signaturePart);
  } catch {
    throw new DomainError(DomainErrorCode.UNAUTHORIZED, 'Invalid session token signature encoding');
  }

  const isValid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    encoder.encode(signingInput)
  );

  if (!isValid) {
    throw new DomainError(DomainErrorCode.UNAUTHORIZED, 'Session token signature verification failed');
  }

  let payloadJson: unknown;
  try {
    const payloadBytes = base64UrlDecode(payloadPart);
    const decodedText = new TextDecoder().decode(payloadBytes);
    payloadJson = JSON.parse(decodedText);
  } catch {
    throw new DomainError(DomainErrorCode.UNAUTHORIZED, 'Invalid session token payload JSON');
  }

  const parseResult = SessionPayloadSchema.safeParse(payloadJson);
  if (!parseResult.success) {
    throw new DomainError(
      DomainErrorCode.UNAUTHORIZED,
      `Corrupted session payload schema: ${parseResult.error.message}`
    );
  }

  const sessionData: SessionPayload = parseResult.data;
  const now = Math.floor(Date.now() / 1000);
  const CLOCK_SKEW_SECONDS = 60;

  if (sessionData.exp <= sessionData.iat) {
    throw new DomainError(
      DomainErrorCode.UNAUTHORIZED,
      'Session token expiration must be strictly after issued-at time'
    );
  }

  if (sessionData.iat > now + CLOCK_SKEW_SECONDS) {
    throw new DomainError(
      DomainErrorCode.UNAUTHORIZED,
      'Session token issued in the future'
    );
  }

  if (sessionData.exp <= now) {
    throw new DomainError(DomainErrorCode.UNAUTHORIZED, 'Session token has expired');
  }

  return sessionData;
}

export function getSessionSecret(env?: Record<string, string | undefined>): string {
  const globalEnv = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const envSource = env ?? globalEnv;
  const secret = envSource?.SESSION_SECRET;
  const nodeEnv = envSource?.NODE_ENV;
  const isDevOrTest = nodeEnv === 'development' || nodeEnv === 'test';

  if (!secret) {
    if (!isDevOrTest) {
      throw new DomainError(
        DomainErrorCode.INTERNAL_ERROR,
        'SESSION_SECRET environment variable is strictly required in production'
      );
    }
    return 'super-secret-session-signing-key-minimum-32-chars-long';
  }

  if (secret.length < 32) {
    throw new DomainError(
      DomainErrorCode.VALIDATION_FAILED,
      'SESSION_SECRET must be at least 32 characters long'
    );
  }

  return secret;
}

export function isSessionAuthorizedForSubdomain(
  session: Pick<SessionPayload, 'subdomain' | 'role'> & { allowedSubdomains?: string[] | undefined },
  requestedSubdomain: string
): boolean {
  if (session.role === 'admin') return true;
  const normalized = requestedSubdomain.toLowerCase();
  return (
    session.subdomain.toLowerCase() === normalized ||
    Boolean(session.allowedSubdomains?.some((sub) => sub.toLowerCase() === normalized))
  );
}
