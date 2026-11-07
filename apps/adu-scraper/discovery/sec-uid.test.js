import assert from 'node:assert/strict';
import test from 'node:test';
import net from 'node:net';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveTiktokSecUid, parseProxyUrl } from './sec-uid.js';

const WORKER = 'https://worker.test';
const WORKER_UID = 'MS4wLjABAAAAworker-sec-uid';
const DIRECT_UID = 'MS4wLjABAAAAdirect-sec-uid';

function okJson(data) {
  return { ok: true, json: async () => data };
}

// Stubs global fetch with a handler; records every URL called. Restores fetch on restore().
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(String(url));
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test('resolveTiktokSecUid handles empty or invalid username', async () => {
  assert.equal(await resolveTiktokSecUid(''), null);
  assert.equal(await resolveTiktokSecUid(null), null);
  assert.equal(await resolveTiktokSecUid('   '), null);
});

test('resolveTiktokSecUid resolves valid TikTok sec_uid or handles network gracefully', async () => {
  const secUid = await resolveTiktokSecUid('mrbeast');
  if (secUid) {
    assert.ok(secUid.startsWith('MS4wLjABAAAA'));
  } else {
    // Graceful network/timeout fallback
    assert.equal(secUid, null);
  }
});

test('Worker success is used and direct Countik is never called', async () => {
  const stub = stubFetch((url) => {
    if (url.startsWith(`${WORKER}/?username=`)) {
      return okJson({ sec_uid: WORKER_UID });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  try {
    const secUid = await resolveTiktokSecUid('someuser', { workerUrl: WORKER });
    assert.equal(secUid, WORKER_UID);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].startsWith(`${WORKER}/?username=someuser`));
  } finally {
    stub.restore();
  }
});

test('Worker failure falls back to direct Countik', async () => {
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      return { ok: false, json: async () => ({ error: 'UPSTREAM_ERROR' }) };
    }
    if (url.startsWith('https://countik.com/api/exist/')) {
      return okJson({ status: 'success', sec_uid: DIRECT_UID });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  try {
    const secUid = await resolveTiktokSecUid('someuser', { workerUrl: WORKER });
    assert.equal(secUid, DIRECT_UID);
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.calls[1].startsWith('https://countik.com/api/exist/someuser'));
  } finally {
    stub.restore();
  }
});

test('Worker throw falls back to direct Countik', async () => {
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      throw new Error('network down');
    }
    return okJson({ status: 'success', sec_uid: DIRECT_UID });
  });
  try {
    const secUid = await resolveTiktokSecUid('someuser', { workerUrl: WORKER });
    assert.equal(secUid, DIRECT_UID);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('Worker response without sec_uid falls back to direct Countik', async () => {
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      return okJson({ error: 'UPSTREAM_ERROR' });
    }
    return okJson({ status: 'success', sec_uid: DIRECT_UID });
  });
  try {
    const secUid = await resolveTiktokSecUid('someuser', { workerUrl: WORKER });
    assert.equal(secUid, DIRECT_UID);
  } finally {
    stub.restore();
  }
});

test('Both sources failing returns null', async () => {
  const stub = stubFetch(() => ({ ok: false, json: async () => ({}) }));
  try {
    const secUid = await resolveTiktokSecUid('someuser', { workerUrl: WORKER });
    assert.equal(secUid, null);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test('Worker sec_uid is trimmed', async () => {
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      return okJson({ sec_uid: `  ${WORKER_UID}  ` });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  try {
    assert.equal(await resolveTiktokSecUid('someuser', { workerUrl: WORKER }), WORKER_UID);
  } finally {
    stub.restore();
  }
});

test('Default Worker URL is used when no override is given', async () => {
  const stub = stubFetch((url) => {
    if (url.startsWith('https://fbuploadpro-secuid.fbuploadpro.workers.dev/?username=')) {
      return okJson({ sec_uid: WORKER_UID });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  try {
    assert.equal(await resolveTiktokSecUid('someuser'), WORKER_UID);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test('Worker timeout falls back to direct Countik', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push(String(url));
    if (String(url).startsWith(WORKER)) {
      // Never resolves on its own; rejects only when the resolver aborts it.
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    return okJson({ status: 'success', sec_uid: DIRECT_UID });
  };
  try {
    const secUid = await resolveTiktokSecUid('someuser', { workerUrl: WORKER, timeoutMs: 50 });
    assert.equal(secUid, DIRECT_UID);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].startsWith('https://countik.com/api/exist/someuser'));
  } finally {
    globalThis.fetch = original;
  }
});

test('Worker sec_uid with non-success status falls back to direct Countik', async () => {
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      return okJson({ sec_uid: WORKER_UID, status: 'error' });
    }
    return okJson({ status: 'success', sec_uid: DIRECT_UID });
  });
  try {
    const secUid = await resolveTiktokSecUid('someuser', { workerUrl: WORKER });
    assert.equal(secUid, DIRECT_UID);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

// --- Countik via proxy (COUNTIK_PROXY_URL) ---
// Test proxy URLs below are dummies (proxy.test / 127.0.0.1); the real proxy
// value never appears in this file.

test('parseProxyUrl parses http proxy URLs and rejects the rest', () => {
  assert.deepEqual(parseProxyUrl('http://user:pass@proxy.test:8080'), {
    host: 'proxy.test',
    port: 8080,
    auth: 'user:pass',
  });
  assert.deepEqual(parseProxyUrl('http://proxy.test'), { host: 'proxy.test', port: 80, auth: null });
  assert.deepEqual(parseProxyUrl('http://proxy.test:3128'), { host: 'proxy.test', port: 3128, auth: null });
  assert.deepEqual(parseProxyUrl('http://user%40domain:p%40ss@proxy.test:8080'), {
    host: 'proxy.test',
    port: 8080,
    auth: 'user@domain:p@ss',
  });
  assert.equal(parseProxyUrl(''), null);
  assert.equal(parseProxyUrl('not a url'), null);
  assert.equal(parseProxyUrl('https://proxy.test:8080'), null);
  assert.equal(parseProxyUrl('http://'), null);
});

// A minimal fake HTTP proxy: records each CONNECT request, then either answers
// with `connectStatus` and drops the socket (plain-TCP tests) or pipes the
// tunnel to `targetPort` (end-to-end TLS test).
function startFakeProxy({ connectStatus = 200, targetPort = null } = {}) {
  const connects = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        return;
      }
      connects.push(buf.subarray(0, end).toString('utf8'));
      const rest = buf.subarray(end + 4);
      socket.removeAllListeners('data');
      const reason = connectStatus === 200 ? 'Connection Established' : 'Proxy Authentication Required';
      socket.write(`HTTP/1.1 ${connectStatus} ${reason}\r\n\r\n`);
      if (connectStatus === 200 && targetPort) {
        const target = net.connect(targetPort, '127.0.0.1', () => {
          if (rest.length) {
            target.write(rest);
          }
          socket.pipe(target);
          target.pipe(socket);
        });
        sockets.add(target);
        target.on('close', () => sockets.delete(target));
        target.on('error', () => socket.destroy());
        socket.on('error', () => target.destroy());
      } else {
        socket.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        connects,
        close: async () => {
          for (const s of sockets) {
            s.destroy();
          }
          await new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

test('Countik fallback goes through the proxy when COUNTIK_PROXY_URL is set', async () => {
  const proxy = await startFakeProxy();
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      return { ok: false, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  try {
    const secUid = await resolveTiktokSecUid('someuser', {
      workerUrl: WORKER,
      countikProxyUrl: `http://user:pass@127.0.0.1:${proxy.port}`,
      timeoutMs: 5000,
    });
    // The TLS handshake against the plain-TCP fake proxy fails, so the
    // resolve returns null — the assertions below are the point: the CONNECT
    // was sent to the proxy (with auth) and no direct Countik fetch happened.
    assert.equal(secUid, null);
    assert.equal(stub.calls.length, 1);
    assert.ok(stub.calls[0].startsWith(`${WORKER}/?username=`));
    assert.equal(proxy.connects.length, 1);
    assert.match(proxy.connects[0], /^CONNECT countik\.com:443 HTTP\/1\.1\r\n/);
    assert.ok(proxy.connects[0].includes(`Proxy-Authorization: Basic ${Buffer.from('user:pass').toString('base64')}`));
  } finally {
    stub.restore();
    await proxy.close();
  }
});

test('Proxy CONNECT failure does not fall back to direct Countik', async () => {
  const proxy = await startFakeProxy({ connectStatus: 407 });
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      return { ok: false, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  try {
    const secUid = await resolveTiktokSecUid('someuser', {
      workerUrl: WORKER,
      countikProxyUrl: `http://user:pass@127.0.0.1:${proxy.port}`,
      timeoutMs: 5000,
    });
    assert.equal(secUid, null);
    assert.equal(stub.calls.length, 1);
    assert.equal(proxy.connects.length, 1);
  } finally {
    stub.restore();
    await proxy.close();
  }
});

test('Invalid COUNTIK_PROXY_URL fails loud without a direct Countik attempt', async () => {
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      return { ok: false, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.equal(await resolveTiktokSecUid('someuser', { workerUrl: WORKER, countikProxyUrl: 'not a url' }), null);
    assert.equal(await resolveTiktokSecUid('someuser', { workerUrl: WORKER, countikProxyUrl: 'https://proxy.test:8080' }), null);
    assert.equal(stub.calls.length, 2); // Worker only, once per call
    assert.equal(errors.length, 2);
    assert.ok(errors.every((line) => line.includes('COUNTIK_PROXY_URL')));
  } finally {
    console.error = originalError;
    stub.restore();
  }
});

test('COUNTIK_PROXY_URL env var is used when no option is passed', async () => {
  const proxy = await startFakeProxy();
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      return { ok: false, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const previous = process.env.COUNTIK_PROXY_URL;
  process.env.COUNTIK_PROXY_URL = `http://user:pass@127.0.0.1:${proxy.port}`;
  try {
    assert.equal(await resolveTiktokSecUid('someuser', { workerUrl: WORKER, timeoutMs: 5000 }), null);
    assert.equal(stub.calls.length, 1);
    assert.equal(proxy.connects.length, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.COUNTIK_PROXY_URL;
    } else {
      process.env.COUNTIK_PROXY_URL = previous;
    }
    stub.restore();
    await proxy.close();
  }
});

test('Countik via proxy resolves a sec_uid end to end', async (t) => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
  } catch {
    t.skip('openssl unavailable — cannot mint a local TLS cert for the proxy e2e test');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secuid-proxy-test-'));
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', path.join(tmpDir, 'key.pem'),
      '-out', path.join(tmpDir, 'cert.pem'),
      '-days', '1', '-nodes',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const tlsServer = https.createServer(
    {
      key: fs.readFileSync(path.join(tmpDir, 'key.pem')),
      cert: fs.readFileSync(path.join(tmpDir, 'cert.pem')),
    },
    (req, res) => {
      if (req.url && req.url.includes('/ratelimited')) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', sec_uid: DIRECT_UID }));
    },
  );
  await new Promise((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
  const tlsPort = tlsServer.address().port;
  const proxy = await startFakeProxy({ targetPort: tlsPort });
  const stub = stubFetch((url) => {
    if (url.startsWith(WORKER)) {
      return { ok: false, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const previousReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const secUid = await resolveTiktokSecUid('someuser', {
      workerUrl: WORKER,
      countikProxyUrl: `http://user:pass@127.0.0.1:${proxy.port}`,
      timeoutMs: 10000,
    });
    assert.equal(secUid, DIRECT_UID);
    assert.equal(stub.calls.length, 1);
    assert.equal(proxy.connects.length, 1);
    assert.match(proxy.connects[0], /^CONNECT countik\.com:443 HTTP\/1\.1\r\n/);
    // A non-2xx through the proxy resolves to null (no direct retry).
    const limited = await resolveTiktokSecUid('ratelimited', {
      workerUrl: WORKER,
      countikProxyUrl: `http://user:pass@127.0.0.1:${proxy.port}`,
      timeoutMs: 10000,
    });
    assert.equal(limited, null);
    assert.equal(stub.calls.length, 2);
    assert.equal(proxy.connects.length, 2);
  } finally {
    if (previousReject === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousReject;
    }
    stub.restore();
    await proxy.close();
    tlsServer.closeAllConnections();
    await new Promise((resolve) => tlsServer.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
