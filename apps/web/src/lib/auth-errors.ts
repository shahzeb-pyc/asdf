/**
 * Regex identifying internal infrastructure, database, socket, or technical plumbing terms
 * that MUST NEVER be exposed in client-facing user interfaces or API response bodies.
 */
const TECHNICAL_LEAK_KEYWORDS = [
  'econnrefused',
  '127.0.0.1',
  'localhost',
  '5432',
  'postgres',
  'pg_pool',
  'pg_',
  'syntax error at or near',
  'relation "',
  'syntaxerror',
  'uncaught',
  'typeerror',
  'internal server',
  'connection refused',
];

const SQL_ACTION_REGEX = /\b(select\s+\*|insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i;
const TIMEOUT_REGEX = /(socket\s+timed?\s*out|timed?\s*out\s+after\s+\d+ms)/i;

function hasTechnicalLeak(message: string): boolean {
  const lower = message.toLowerCase();
  if (TECHNICAL_LEAK_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    return true;
  }
  return SQL_ACTION_REGEX.test(message) || TIMEOUT_REGEX.test(message);
}

/**
 * Sanitizes any raw error string before rendering to user-visible frontend components.
 * If any internal infrastructure or diagnostic plumbing keywords are detected,
 * replaces them with a clean, reassuring commercial SaaS message.
 */
function extractRawErrorMessage(raw: unknown): string | null {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw instanceof Error) {
    return raw.message;
  }
  if (raw && typeof raw === 'object' && 'message' in raw) {
    return String((raw as { message: unknown }).message);
  }
  return null;
}

export function sanitizeAuthErrorMessage(
  rawMessage: unknown,
  fallbackMessage: string = 'Unable to complete your request at this moment. Please try again shortly.'
): string {
  const message = extractRawErrorMessage(rawMessage);

  if (!message?.trim()) {
    return fallbackMessage;
  }

  const trimmed = message.trim();

  if (hasTechnicalLeak(trimmed)) {
    return fallbackMessage;
  }

  return trimmed;
}

/**
 * Plain user-facing message for Supabase Auth's project-wide hourly
 * email budget (GoTrue `over_email_send_rate_limit`, message "email
 * rate limit exceeded"). Unlike the per-address "after N seconds"
 * cooldown, this error carries NO retry timing — the budget resets on
 * a rolling hour — so no response for it may invent a countdown.
 */
export const EMAIL_RATE_LIMIT_MESSAGE =
  "We couldn't send your verification code right now because email sending is temporarily at its limit. Please try again in a little while.";

/**
 * True when the error is Supabase Auth's hourly email-budget limit,
 * whether it arrives as a thrown error with the GoTrue code, a thrown
 * error carrying the raw message, or the raw message itself.
 */
export function isEmailRateLimitError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (
    typeof code === 'string' &&
    (code === 'EMAIL_RATE_LIMITED' || code === 'over_email_send_rate_limit')
  ) {
    return true;
  }
  const message = extractRawErrorMessage(error);
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('email rate limit exceeded') || lower.includes('over_email_send_rate_limit');
}
