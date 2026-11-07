/**
 * Proxy-aware fetch for the Cloudflare Worker (spec 150).
 *
 * A Worker has no `fetch()` proxy option, so routing the mirror resolve
 * through the DataImpulse rotating proxy is done with a raw TCP tunnel:
 * `cloudflare:sockets` `connect()` with `secureTransport: "starttls"`,
 * a `CONNECT <target>:443` request to the proxy, then `startTls()` and a
 * hand-written HTTP/1.1 request/response over the tunnel. This mirrors the
 * proven Node implementation in `apps/adu-scraper/discovery/sec-uid.js`
 * (`ProxyHttpsAgent`, PR #170) — same three steps, Worker socket API
 * instead of `node:http`/`node:tls`.
 *
 * Scope: this fetch is for RESOLVE ONLY (free tikwm POST + Countik
 * exist/videoinfo, threaded into `resolveTikwmVideo` as its `fetchFn`).
 * It must never be used for video downloads or Facebook/Instagram/Threads
 * publishing — those paths never receive it.
 *
 * Secret hygiene: the proxy URL (including credentials) is never logged.
 * Upstream socket/TLS errors can embed the proxy credential in their
 * message, so every error rethrown from the tunnel is redacted of all
 * proxy-value forms (full URL, host, user, pass, base64(user:pass),
 * URL-encoded forms) before it escapes — the thrown message is stored
 * in the DB by the mirror tick and logged by the resolve caller, so a
 * verbatim rethrow would persist the credential. Our own InternalErrors
 * name the phase and the target host only. The caller passes the URL
 * in; this module never reads env itself.
 *
 * `cloudflare:sockets` is imported LAZILY (dynamic import inside the
 * factory) because the Worker's vitest pool is plain Node, where that
 * module does not exist. Tests inject a stub `connect` instead.
 */

import { InternalError } from '@fbuploadpro/contracts';

export interface ProxyUrl {
  host: string;
  port: number;
  /** `user:pass` (decoded) or null when the URL carries no credentials. */
  auth: string | null;
}

/**
 * Parse an `http://[user:pass@]host[:port]` proxy URL. Only plain `http:`
 * is accepted (same rule as the scraper's `parseProxyUrl`); `https:`
 * is rejected because a CONNECT proxy URL is itself plain HTTP.
 * Returns null when the value is not a usable proxy URL.
 */
export function parseProxyUrl(raw: string): ProxyUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' || !parsed.hostname) {
    return null;
  }
  return {
    host: parsed.hostname,
    port: Number(parsed.port) || 80,
    auth: parsed.username
      ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
      : null,
  };
}

/** Minimal socket shape used by the tunnel (real `cloudflare:sockets` Socket satisfies it). */
export interface TunnelSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
  startTls(options?: { expectedServerHostname?: string }): TunnelSocket | Promise<TunnelSocket>;
}

export type TunnelConnectFn = (options: {
  hostname: string;
  port: number;
}) => TunnelSocket | Promise<TunnelSocket>;

async function defaultConnect(
  hostname: string,
  port: number,
): Promise<TunnelSocket> {
  const { connect } = await import('cloudflare:sockets');
  const socket = connect(
    { hostname, port },
    { secureTransport: 'starttls', allowHalfOpen: false },
  );
  // Fail fast when the proxy itself is unreachable, before writing CONNECT.
  await socket.opened;
  return socket as unknown as TunnelSocket;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function toBase64(value: string): string {
  const bytes = TEXT_ENCODER.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toBytes(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

/**
 * Every form in which the proxy credential can appear in an upstream
 * error message: the full URL as passed in, host, decoded `user:pass`,
 * user and pass separately, the `auth@host` forms, the base64 of the
 * auth as sent in `Proxy-Authorization`, and the URL-encoded forms
 * (the raw URL's userinfo is percent-encoded). Longest first, so a
 * full URL / base64 token is replaced whole instead of being broken
 * up by a shorter component match. Same pattern as the scraper's
 * `redactProxyValues` (PR #173) — fake values only, never a secret.
 */
function collectProxySecrets(rawProxyUrl: string, proxy: ProxyUrl): string[] {
  const values: string[] = [];
  const add = (value: string | null | undefined): void => {
    const trimmed = (value ?? '').trim();
    if (trimmed && !values.includes(trimmed)) values.push(trimmed);
  };
  add(rawProxyUrl);
  add(proxy.host);
  add(`${proxy.host}:${proxy.port}`);
  add(proxy.auth);
  if (proxy.auth) {
    const colon = proxy.auth.indexOf(':');
    const user = colon >= 0 ? proxy.auth.slice(0, colon) : proxy.auth;
    const pass = colon >= 0 ? proxy.auth.slice(colon + 1) : '';
    add(user);
    add(pass);
    add(`${proxy.auth}@${proxy.host}`);
    add(`${proxy.auth}@${proxy.host}:${proxy.port}`);
    add(encodeURIComponent(user));
    add(encodeURIComponent(pass));
    add(encodeURIComponent(proxy.auth));
    add(toBase64(proxy.auth));
    add(toBase64(encodeURIComponent(proxy.auth)));
    add(toBase64(`${encodeURIComponent(user)}:${encodeURIComponent(pass)}`));
  }
  return values.sort((a, b) => b.length - a.length);
}

/** Replace every collected proxy value in `text` with `[proxy]`. */
function redactProxyValues(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join('[proxy]');
  }
  return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Buffered reader over a socket stream: line/exact/to-end reads. */
class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffered: Uint8Array[] = [];
  private bufferedLength = 0;
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async fill(): Promise<boolean> {
    // Always attempt a real read. Callers only call fill() when the
    // buffered bytes are not enough for the line/chunk they need, so
    // returning true here without reading would spin forever on a
    // response line split across TCP segments — and the spin starves
    // the event loop, so even the abort timer could not fire.
    for (;;) {
      if (this.ended) return false;
      const { done, value } = await this.reader.read();
      if (done) {
        this.ended = true;
        return false;
      }
      if (value.byteLength > 0) {
        this.buffered.push(value);
        this.bufferedLength += value.byteLength;
        return true;
      }
      // Zero-length chunk: read again instead of reporting "more data".
    }
  }

  private take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count && this.buffered.length > 0) {
      const first = this.buffered[0] as Uint8Array;
      const take = Math.min(first.byteLength, count - offset);
      out.set(first.subarray(0, take), offset);
      offset += take;
      if (take === first.byteLength) this.buffered.shift();
      else this.buffered[0] = first.subarray(take);
    }
    this.bufferedLength -= count;
    return out;
  }

  /**
   * Release the reader lock. Required before the socket is upgraded
   * with `startTls()`: in workerd a reader still locked on the plain
   * socket breaks the TLS phase (the TLS write hangs, or startTls
   * throws "The ReadableStream has been locked to a reader"). Call
   * only when no read is pending — i.e. after the headers/body the
   * reader was used for have been fully read.
   */
  release(): void {
    this.reader.releaseLock();
  }

  /** Read bytes up to and including the delimiter; null on EOF first. */
  async readUntil(delimiter: Uint8Array): Promise<Uint8Array | null> {
    for (;;) {
      const joined = concatBytes(this.buffered);
      const idx = findSubarray(joined, delimiter);
      if (idx >= 0) return this.take(idx + delimiter.byteLength);
      if (!(await this.fill())) {
        return this.bufferedLength > 0 ? this.take(this.bufferedLength) : null;
      }
    }
  }

  async readLine(): Promise<string | null> {
    const line = await this.readUntil(toBytes('\r\n'));
    if (line === null) return null;
    const hasCrlf =
      line.byteLength >= 2 && line[line.byteLength - 2] === 13 && line[line.byteLength - 1] === 10;
    return TEXT_DECODER.decode(hasCrlf ? line.subarray(0, line.byteLength - 2) : line);
  }

  async readExact(count: number): Promise<Uint8Array> {
    while (this.bufferedLength < count) {
      if (!(await this.fill())) {
        throw new InternalError('proxy response ended early');
      }
    }
    return this.take(count);
  }

  async readToEnd(): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    if (this.bufferedLength > 0) {
      chunks.push(this.take(this.bufferedLength));
    }
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done) break;
      if (value.byteLength > 0) chunks.push(value);
    }
    return concatBytes(chunks);
  }
}

function findSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.byteLength <= haystack.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

interface ParsedHeaders {
  headers: Array<[string, string]>;
  get(name: string): string | null;
}

async function readHeaders(reader: ByteReader): Promise<ParsedHeaders> {
  const headers: Array<[string, string]> = [];
  for (;;) {
    const line = await reader.readLine();
    if (line === null) throw new InternalError('proxy response ended early');
    if (line === '') break;
    const colon = line.indexOf(':');
    if (colon < 0) throw new InternalError('proxy response has a malformed header');
    headers.push([
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    ]);
  }
  return {
    headers,
    get(name: string) {
      const found = headers.find(([key]) => key === name.toLowerCase());
      return found ? (found[1] as string) : null;
    },
  };
}

async function readChunkedBody(reader: ByteReader): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const sizeLine = await reader.readLine();
    if (sizeLine === null) {
      // tikwm (via Cloudflare) closes a chunked response after the
      // last chunk without sending the terminal 0-chunk. EOF at a
      // chunk boundary after at least one complete chunk is therefore
      // end-of-body, not a truncation. EOF before any chunk, or
      // mid-chunk (readExact below), is still a truncated response.
      if (chunks.length > 0) break;
      throw new InternalError('proxy response ended early');
    }
    const size = Number.parseInt(sizeLine.split(';')[0]?.trim() ?? '', 16);
    if (!Number.isFinite(size) || size < 0) {
      throw new InternalError('proxy response has a malformed chunk size');
    }
    if (size === 0) {
      // Consume trailers up to the empty line.
      for (;;) {
        const trailer = await reader.readLine();
        if (trailer === null || trailer === '') break;
      }
      break;
    }
    chunks.push(await reader.readExact(size));
    const crlf = await reader.readExact(2);
    if (crlf[0] !== 13 || crlf[1] !== 10) {
      throw new InternalError('proxy response has a malformed chunk');
    }
  }
  return concatBytes(chunks);
}

function bodyBytes(input: BodyInit | null | undefined): Uint8Array {
  if (input === null || input === undefined) return new Uint8Array(0);
  if (typeof input === 'string') return toBytes(input);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof URLSearchParams !== 'undefined' && input instanceof URLSearchParams) {
    return toBytes(input.toString());
  }
  throw new InternalError('proxy fetch: unsupported request body type');
}

/**
 * Throw the signal's reason when aborted. Kept behind a helper so the
 * linter's control-flow narrowing (which cannot see async aborts) does
 * not flag the checks as always-false.
 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted.', 'AbortError');
  }
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface ProxyFetchOptions {
  /** `http://[user:pass@]host[:port]` — the DATAIMPULSE_PROXY value. */
  proxyUrl: string;
  /**
   * Socket connector override (tests only). Defaults to the lazy
   * `cloudflare:sockets` import. Never pass a direct `fetch` here —
   * that would silently bypass the proxy.
   */
  connect?: TunnelConnectFn | undefined;
}

/**
 * Build a `fetch`-shaped function that performs HTTPS requests through
 * an HTTP CONNECT proxy. Throws at factory time when the proxy URL is
 * invalid, and throws (never falls back to direct `fetch`) on any
 * proxy failure. Our own error messages name the phase and target host
 * only; upstream error messages are redacted of every proxy-value form
 * before they are rethrown.
 */
export function createProxyFetchFn(
  options: ProxyFetchOptions,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const proxy = parseProxyUrl(options.proxyUrl);
  if (!proxy) {
    throw new InternalError(
      'Mirror resolve proxy is not a valid http proxy URL; refusing to resolve directly.',
    );
  }
  const connectFn: TunnelConnectFn =
    options.connect ?? ((opts) => defaultConnect(opts.hostname, opts.port));
  // Collected once: every form the proxy credential can take in an
  // upstream error message, for redaction before any rethrow.
  const proxySecrets = collectProxySecrets(options.proxyUrl, proxy);

  return async function proxyFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    if (url.protocol !== 'https:') {
      throw new InternalError(`proxy fetch only supports https targets: ${url.host}`);
    }
    // `URL.host` omits the default :443 — the CONNECT authority needs it explicit.
    const targetHost = url.hostname;
    const targetAuthority = `${url.hostname}:443`;
    const method =
      init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET');
    const signal = init?.signal ?? AbortSignal.timeout(30_000);
    throwIfAborted(signal);

    const requestBody = bodyBytes(
      init?.body ??
        (typeof input !== 'string' && !(input instanceof URL)
          ? await input.clone().text()
          : null),
    );
    const requestHeaders = new Headers(
      init?.headers ??
        (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined),
    );
    requestHeaders.set('Host', url.host);
    requestHeaders.set('Content-Length', String(requestBody.byteLength));
    requestHeaders.set('Connection', 'close');
    requestHeaders.delete('Proxy-Authorization');

    // Holder (not a plain variable): assignments inside the task closure
    // are invisible to TS narrowing, so a `let` reads as `never` in finally.
    const socketRef: { current: TunnelSocket | null } = { current: null };
    // Holder object (not a plain boolean): TS cannot see the closure
    // assignment, so a `let aborted = false` reads as always-false.
    const abortState = { aborted: false };
    const onAbort = (): void => {
      abortState.aborted = true;
      void socketRef.current?.close().catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const task = (async (): Promise<Response> => {
        const plainSocket = await connectFn({ hostname: proxy.host, port: proxy.port });
        socketRef.current = plainSocket;
        const connectHeaders = [
          `CONNECT ${targetAuthority} HTTP/1.1`,
          `Host: ${targetAuthority}`,
        ];
        if (proxy.auth) {
          connectHeaders.push(`Proxy-Authorization: Basic ${toBase64(proxy.auth)}`);
        }
        const writer = plainSocket.writable.getWriter();
        try {
          await writer.write(toBytes(`${connectHeaders.join('\r\n')}\r\n\r\n`));
        } finally {
          writer.releaseLock();
        }
        throwIfAborted(signal);

        const connectReader = new ByteReader(plainSocket.readable);
        const connectStatus = await connectReader.readLine();
        if (connectStatus === null) {
          throw new InternalError(`proxy connect to ${targetHost} failed: empty response`);
        }
        const connectCode = Number(connectStatus.split(' ')[1]);
        // Consume the CONNECT response headers (any bytes after them do
        // not exist for CONNECT; leftovers in the reader are discarded
        // with the plain socket below).
        await readHeaders(connectReader);
        if (connectCode !== 200) {
          throw new InternalError(`proxy connect to ${targetHost} failed: HTTP ${connectCode}`);
        }

        // Release the CONNECT reader before upgrading: a reader still
        // locked on the plain socket breaks startTls in workerd (the
        // TLS write hangs, or startTls throws "The ReadableStream has
        // been locked to a reader"). The proxy sends nothing after the
        // CONNECT response, so no buffered bytes are lost here.
        connectReader.release();
        // Pin TLS verification (SNI + certificate) to the target host,
        // not the proxy.
        const tlsSocket = await plainSocket.startTls({ expectedServerHostname: targetHost });
        socketRef.current = tlsSocket;
        const tlsWriter = tlsSocket.writable.getWriter();
        try {
          const path = `${url.pathname}${url.search}`;
          const lines = [`${method} ${path} HTTP/1.1`];
          requestHeaders.forEach((value, name) => {
            lines.push(`${name}: ${value}`);
          });
          await tlsWriter.write(toBytes(`${lines.join('\r\n')}\r\n\r\n`));
          if (requestBody.byteLength > 0) {
            await tlsWriter.write(requestBody);
          }
        } finally {
          tlsWriter.releaseLock();
        }
        throwIfAborted(signal);

        const reader = new ByteReader(tlsSocket.readable);
        const statusLine = await reader.readLine();
        if (statusLine === null) {
          throw new InternalError(`proxy response from ${targetHost} ended early`);
        }
        const statusParts = statusLine.split(' ');
        const status = Number(statusParts[1]);
        if (!Number.isFinite(status)) {
          throw new InternalError(`proxy response from ${targetHost} has a malformed status line`);
        }
        const statusText = statusParts.slice(2).join(' ');
        const parsed = await readHeaders(reader);
        let body: Uint8Array;
        if (status === 204 || status === 304) {
          body = new Uint8Array(0);
        } else if ((parsed.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
          body = await readChunkedBody(reader);
        } else {
          const contentLength = parsed.get('content-length');
          if (contentLength !== null) {
            // `Number('abc')` is NaN and `readExact(NaN)` returns an
            // empty body — a malformed length must fail loud, never a
            // silent HTTP 200 with an empty body. A negative length
            // must be the same InternalError, not a bare RangeError
            // from `new Uint8Array(-5)`.
            const length = Number(contentLength);
            if (!Number.isInteger(length) || length < 0) {
              throw new InternalError('proxy response has a malformed content-length');
            }
            body = await reader.readExact(length);
          } else {
            body = await reader.readToEnd();
          }
        }
        const responseHeaders = new Headers();
        for (const [name, value] of parsed.headers) {
          if (!HOP_BY_HOP.has(name)) responseHeaders.append(name, value);
        }
        // Body fully read; release the reader before the socket is closed.
        reader.release();
        return new Response(body, { status, statusText, headers: responseHeaders });
      })();

      return await task;
    } catch (err) {
      if (abortState.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The operation was aborted.', 'AbortError');
      }
      if (err instanceof Error) {
        // Upstream errors (connect, startTls, the TLS writer, the TLS
        // reader) can embed the proxy credential in their message, and
        // the thrown message is stored in the DB by the mirror tick
        // and logged by the resolve caller — so no upstream message
        // escapes verbatim. Our own InternalErrors name the phase and
        // the target host only, so redacting them is a no-op; every
        // rethrown message is redacted all the same, so no path can
        // leak. The abort branch above (caller's own timeout reason)
        // is untouched.
        throw new InternalError(redactProxyValues(err.message, proxySecrets));
      }
      throw new InternalError(`proxy fetch to ${targetHost} failed`);
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (socketRef.current) await socketRef.current.close().catch(() => undefined);
    }
  };
}
