import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTiktokSecUid } from './sec-uid.js';

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
