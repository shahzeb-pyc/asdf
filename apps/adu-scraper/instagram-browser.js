// Dedicated Instagram browser (spec scraper-ig-residential-proxies):
// Instagram discovery runs in its OWN headed Puppeteer browser —
// never the shared browser Facebook uses — behind ONE residential
// proxy: the FIRST entry of INSTAGRAM_PROXIES. No rotation across
// the pool, no fallback to other pool entries, never the rotating
// proxy (COUNTIK_PROXY_URL, owner constraint 2026-11-11), never
// direct. The browser is launched lazily on the first Instagram job
// and kept alive across jobs (restart on death / after 500 jobs,
// same discipline as the shared browser); its session lives in its
// own profile dir and survives restarts.
//
// This module is dependency-free (node builtins only) and pure
// except for InstagramBrowserManager, whose launch function is
// injected — so the behavioural tests run without a browser, a
// network, or the proxy secret. It never reads env itself; callers
// pass the raw INSTAGRAM_PROXIES value in.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const INSTAGRAM_MAX_ATTEMPTS = 3;
export const INSTAGRAM_RETRY_BACKOFF_MS = 5000;
export const INSTAGRAM_MAX_JOBS_PER_SESSION = 500;
export const INSTAGRAM_DEFAULT_USER_DATA_DIR = '.browser-profile-ig';

// Parse the INSTAGRAM_PROXIES pool (comma-separated entries in
// either `http://user:pass@host:port` URL form — the pool's real
// format, canonical with the downloader — or bare
// `host:port:user:pass` form) and return ONLY the first entry —
// the single proxy Instagram ever uses. A missing, empty, or
// malformed first entry is a loud failure ({ ok: false, reason }),
// never a silent pick of another entry. The reason never contains
// the raw value (it carries credentials).
export function parseInstagramProxyPool(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return {
      ok: false,
      reason: 'INSTAGRAM_PROXIES is not set (empty pool) — Instagram needs the first residential proxy in the scraper .env',
    };
  }
  const first = value
    .split(',')
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!first) {
    return { ok: false, reason: 'INSTAGRAM_PROXIES has no usable entry (empty pool)' };
  }
  const parsed = /^https?:\/\//i.test(first) ? parseInstagramProxyUrl(first) : parseInstagramProxyBare(first);
  if (!parsed) {
    return {
      ok: false,
      reason: 'INSTAGRAM_PROXIES first entry is malformed — expected http://user:pass@host:port or host:port:user:pass',
    };
  }
  return { ok: true, proxy: parsed };
}

// URL form: http(s)://user:pass@host:port. Returns the parsed proxy
// or null when malformed. Percent-encoded credentials are decoded;
// a missing port means the scheme's default (80 / 443).
function parseInstagramProxyUrl(entry) {
  let url;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let username;
  let password;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    return null;
  }
  const port = Number(url.port || (url.protocol === 'https:' ? '443' : '80'));
  if (!url.hostname || !username || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host: url.hostname, port, username, password };
}

// Bare form: host:port:user:pass (password may contain colons).
// Returns the parsed proxy or null when malformed.
function parseInstagramProxyBare(entry) {
  const parts = entry.split(':');
  const [host, portRaw, username, ...passwordParts] = parts;
  const password = passwordParts.join(':');
  const port = Number(portRaw);
  if (!host || !portRaw || !username || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port, username, password };
}

// The --proxy-server value for a parsed proxy. Credentials never go
// in the launch args — the page authenticates separately (see
// index.js processInstagramJob, page.authenticate).
export function proxyServerUrl(proxy) {
  return `http://${proxy.host}:${proxy.port}`;
}

// Strip every credential-bearing form of the proxy from log text,
// exactly like discovery/ytdlp.js redactProxyValues does for yt-dlp:
// the raw `host:port:user:pass` entry, the `user:pass@host:port`
// URL forms, the bare `user:pass`, and the bare password. The
// host:port alone is not a credential and is left intact (it is what
// the startup log names so a dead proxy can be identified).
export function redactInstagramProxyCredentials(text, proxy) {
  let out = String(text ?? '');
  if (!proxy) return out;
  const forms = [
    `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`,
    `${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`,
    `${proxy.host}:${proxy.port}:${proxy.username}:${proxy.password}`,
    `${proxy.username}:${proxy.password}`,
    proxy.password,
  ];
  for (const form of forms) {
    if (form) out = out.split(form).join('[proxy]');
  }
  return out;
}

// Whether a thrown error is a proxy failure (connect failure,
// tunnel failure, timeout, HTTP 429 from Instagram). Proxy failures
// are the only ones retried; anything else fails the job at once.
// An error explicitly marked `isProxyFailure` (thrown by
// scrapers/instagram.js on a 429 / navigation failure) counts
// regardless of its message text.
const PROXY_FAILURE_MARKERS = [
  'ERR_PROXY',
  'ERR_TUNNEL',
  'HTTP 429',
  'Navigation timeout',
  'ERR_TIMED_OUT',
  'ERR_CONNECTION_TIMED_OUT',
];
export function isProxyFailure(error) {
  if (!error) return false;
  if (error.isProxyFailure === true) return true;
  const message = String(error.message || error);
  return PROXY_FAILURE_MARKERS.some((marker) => message.includes(marker));
}

// Puppeteer launch options for the dedicated Instagram browser:
// headed, own profile dir, same hardening args as the shared browser
// plus --proxy-server for the single proxy. Throws without a proxy —
// launching Instagram direct is never an option.
export function buildInstagramLaunchOptions({ userDataDir, proxy, executablePath = null } = {}) {
  if (!proxy) {
    throw new Error('Instagram launch needs a proxy — INSTAGRAM_PROXIES first entry is missing or malformed');
  }
  const options = {
    headless: false,
    defaultViewport: null,
    userDataDir,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--lang=en-US,en',
      `--proxy-server=${proxyServerUrl(proxy)}`,
    ],
  };
  if (executablePath) {
    options.executablePath = executablePath;
  }
  return options;
}

// Run one Instagram job attempt function with proxy retries: on a
// proxy failure, retry on the SAME single proxy (up to maxAttempts,
// short backoff between attempts). A non-proxy failure throws
// immediately — retrying it on the same proxy would be pointless.
// Returns whatever the attempt function returns.
export async function runInstagramJobWithRetries(
  runAttempt,
  { maxAttempts = INSTAGRAM_MAX_ATTEMPTS, backoffMs = INSTAGRAM_RETRY_BACKOFF_MS, sleepFn = sleep, log = console } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runAttempt(attempt);
    } catch (error) {
      lastError = error;
      if (!isProxyFailure(error) || attempt >= maxAttempts) throw error;
      // The error message is NOT logged here: it can carry proxy
      // text. The final throw is logged (redacted) by the caller.
      log.warn(`[instagram] proxy failure on attempt ${attempt}/${maxAttempts} — retrying on the same proxy in ${backoffMs}ms`);
      await sleepFn(backoffMs);
    }
  }
  throw lastError;
}

// The persistent Instagram browser: launched lazily by the injected
// launch function on the first job and kept alive across jobs — the
// same instance is returned until it dies (connected false) or the
// 500-job session limit is hit, when it is closed and relaunched.
// The launch function is injected so tests can prove persistence
// without a real browser.
export class InstagramBrowserManager {
  constructor({ launch, maxJobsPerSession = INSTAGRAM_MAX_JOBS_PER_SESSION, log = console } = {}) {
    if (typeof launch !== 'function') {
      throw new Error('InstagramBrowserManager needs a launch function');
    }
    this.launch = launch;
    this.maxJobsPerSession = maxJobsPerSession;
    this.log = log;
    this.browser = null;
    this.jobsCompleted = 0;
  }

  async getBrowser() {
    if (this.browser) {
      let connected = false;
      try {
        // Real Puppeteer 25 API: liveness is the `connected` getter
        // property — there is no isConnected() method (calling it
        // throws, which this catch would misread as "died").
        connected = this.browser.connected === true;
      } catch {
        connected = false;
      }
      if (connected) {
        if (this.jobsCompleted < this.maxJobsPerSession) {
          return this.browser;
        }
        this.log.log(`[instagram] restarting the Instagram browser after ${this.jobsCompleted} jobs (500-job session limit)`);
        await this.closeBrowser();
      } else {
        this.log.error('[instagram] Instagram browser died — relaunching it');
        await this.closeBrowser();
      }
    }
    this.browser = await this.launch();
    this.jobsCompleted = 0;
    return this.browser;
  }

  noteJobCompleted() {
    this.jobsCompleted += 1;
  }

  async closeBrowser() {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch (error) {
      this.log.warn('[instagram] could not close the Instagram browser:', error?.message || error);
    }
    this.browser = null;
  }
}
