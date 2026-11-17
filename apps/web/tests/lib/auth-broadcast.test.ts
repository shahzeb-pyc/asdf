import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVE_USER_STORAGE_KEY,
  AUTH_EVENT_STORAGE_KEY,
  AUTH_LOGOUT_STORAGE_KEY,
  broadcastAuthEvent,
  completeAuthRedirect,
  subscribeAuthEvents,
  type AuthBroadcastPayload,
} from '@/lib/auth-broadcast';

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  close = vi.fn();
  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }
}

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: vi.fn((key: string) => map.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      map.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      map.delete(key);
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  MockBroadcastChannel.instances = [];
});

describe('broadcastAuthEvent — BroadcastChannel primary (spec 137 T17)', () => {
  it('posts LOGIN via the channel and persists the active user; no storage-event fallback write', () => {
    const storage = fakeStorage();
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });

    broadcastAuthEvent({ type: 'LOGIN', userId: 'u1', email: 'a@example.com' });

    const channel = MockBroadcastChannel.instances[0];
    expect(channel?.name).toBe('fbup_auth');
    expect(channel?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOGIN', userId: 'u1', email: 'a@example.com' })
    );
    expect(channel?.close).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(ACTIVE_USER_STORAGE_KEY, 'u1');
    expect(storage.setItem).not.toHaveBeenCalledWith(
      AUTH_EVENT_STORAGE_KEY,
      expect.anything()
    );
  });

  it('posts LOGOUT via the channel and persists the logout timestamp + clears the active user', () => {
    const storage = fakeStorage();
    storage.map.set(ACTIVE_USER_STORAGE_KEY, 'u-old');
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });

    broadcastAuthEvent({ type: 'LOGOUT' });

    expect(MockBroadcastChannel.instances[0]?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOGOUT' })
    );
    expect(storage.setItem).toHaveBeenCalledWith(AUTH_LOGOUT_STORAGE_KEY, expect.any(String));
    expect(storage.removeItem).toHaveBeenCalledWith(ACTIVE_USER_STORAGE_KEY);
  });
});

describe('broadcastAuthEvent — storage-event fallback only', () => {
  it('writes the full payload to the fallback key when BroadcastChannel is unavailable', () => {
    const storage = fakeStorage();
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });

    broadcastAuthEvent({ type: 'USER_SWITCH', userId: 'u2' });

    const raw = storage.map.get(AUTH_EVENT_STORAGE_KEY);
    expect(raw).toBeDefined();
    const payload = JSON.parse(raw as string) as AuthBroadcastPayload;
    expect(payload.type).toBe('USER_SWITCH');
    expect(payload.userId).toBe('u2');
    expect(typeof payload.timestamp).toBe('number');
    expect(storage.setItem).toHaveBeenCalledWith(ACTIVE_USER_STORAGE_KEY, 'u2');
  });

  it('falls back when the channel constructor throws, without throwing itself', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class BrokenChannel {
      constructor() {
        throw new Error('unsupported');
      }
    }
    const storage = fakeStorage();
    vi.stubGlobal('BroadcastChannel', BrokenChannel);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });

    expect(() =>
      broadcastAuthEvent({ type: 'SESSION_CHANGE', userId: 'u3' })
    ).not.toThrow();
    expect(storage.map.has(AUTH_EVENT_STORAGE_KEY)).toBe(true);
  });

  it('is a no-op outside a browser environment', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', undefined);
    expect(() => broadcastAuthEvent({ type: 'LOGOUT' })).not.toThrow();
  });

  it('survives storage writes that throw in both transports', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('quota');
      }),
      removeItem: vi.fn(() => {
        throw new Error('quota');
      }),
    });
    expect(() => broadcastAuthEvent({ type: 'LOGOUT' })).not.toThrow();
    expect(() => broadcastAuthEvent({ type: 'LOGIN', userId: 'u1' })).not.toThrow();
  });
});

describe('subscribeAuthEvents', () => {
  it('subscribes via BroadcastChannel when available and unsubscribes by closing', () => {
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.stubGlobal('window', {});
    const listener = vi.fn();
    const unsubscribe = subscribeAuthEvents(listener);

    const channel = MockBroadcastChannel.instances[0];
    expect(channel?.name).toBe('fbup_auth');
    channel?.onmessage?.({
      data: { type: 'LOGOUT', timestamp: 123 },
    } as MessageEvent);
    expect(listener).toHaveBeenCalledWith({ type: 'LOGOUT', timestamp: 123 });

    // Malformed messages are ignored.
    channel?.onmessage?.({ data: 'nope' } as MessageEvent);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(channel?.close).toHaveBeenCalledTimes(1);
  });

  it('tolerates a channel close that throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class ThrowingCloseChannel extends MockBroadcastChannel {
      close = vi.fn(() => {
        throw new Error('nope');
      });
    }
    vi.stubGlobal('BroadcastChannel', ThrowingCloseChannel);
    vi.stubGlobal('window', {});
    const unsubscribe = subscribeAuthEvents(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });

  it('falls back to storage events when BroadcastChannel is unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const handlers = new Map<string, (event: StorageEvent) => void>();
    const fakeWindow = {
      addEventListener: vi.fn((type: string, handler: (event: StorageEvent) => void) => {
        handlers.set(type, handler);
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal('window', fakeWindow);

    const listener = vi.fn();
    const unsubscribe = subscribeAuthEvents(listener);
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith('storage', expect.any(Function));
    const handler = handlers.get('storage');
    expect(handler).toBeDefined();

    handler?.({
      key: AUTH_EVENT_STORAGE_KEY,
      newValue: JSON.stringify({ type: 'LOGIN', userId: 'u9', timestamp: 42 }),
    } as StorageEvent);
    expect(listener).toHaveBeenCalledWith({ type: 'LOGIN', userId: 'u9', timestamp: 42 });

    handler?.({ key: AUTH_LOGOUT_STORAGE_KEY, newValue: '777' } as StorageEvent);
    expect(listener).toHaveBeenCalledWith({ type: 'LOGOUT', timestamp: 777 });

    // Corrupt payloads and unrelated keys are ignored.
    handler?.({ key: AUTH_EVENT_STORAGE_KEY, newValue: '{broken' } as StorageEvent);
    handler?.({ key: AUTH_EVENT_STORAGE_KEY, newValue: JSON.stringify({ nope: true }) } as StorageEvent);
    handler?.({ key: 'unrelated', newValue: 'x' } as StorageEvent);
    handler?.({ key: AUTH_EVENT_STORAGE_KEY, newValue: null } as StorageEvent);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(fakeWindow.removeEventListener).toHaveBeenCalledWith('storage', handler);
  });

  it('falls back to storage events when the channel constructor throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    class BrokenChannel {
      constructor() {
        throw new Error('unsupported');
      }
    }
    vi.stubGlobal('BroadcastChannel', BrokenChannel);
    const fakeWindow = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('window', fakeWindow);
    const unsubscribe = subscribeAuthEvents(vi.fn());
    expect(fakeWindow.addEventListener).toHaveBeenCalledWith('storage', expect.any(Function));
    unsubscribe();
  });

  it('returns a no-op unsubscribe outside a browser environment', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('window', undefined);
    const unsubscribe = subscribeAuthEvents(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('completeAuthRedirect — brand-aware redirect (spec 204)', () => {
  const originalRootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN;
  const originalVercelUrl = process.env.VERCEL_URL;

  beforeEach(() => {
    // Production-like roots: the fbuploadpro root comes from env, the
    // white-label root is the contracts constant.
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'fbuploadpro.com';
    delete process.env.VERCEL_URL;
  });

  afterEach(() => {
    if (originalRootDomain === undefined) {
      delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
    } else {
      process.env.NEXT_PUBLIC_ROOT_DOMAIN = originalRootDomain;
    }
    if (originalVercelUrl === undefined) {
      delete process.env.VERCEL_URL;
    } else {
      process.env.VERCEL_URL = originalVercelUrl;
    }
  });

  function stubBrowserWindow(hostname: string) {
    const storage = fakeStorage();
    const location = {
      hostname,
      host: hostname,
      origin: `https://${hostname}`,
      href: '',
    };
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage, location });
    return location;
  }

  it('keeps a white-label login on the white-label tenant host', () => {
    const location = stubBrowserWindow('app.sajidaliai.online');
    completeAuthRedirect('https://sajidali.app.sajidaliai.online/', {
      id: 'u1',
      email: 'sajidali@protonsemail.com',
      subdomain: 'sajidali',
    });
    expect(location.href).toBe('https://sajidali.app.sajidaliai.online/');
  });

  it('honours a white-label returnUrl path on the white-label host', () => {
    const location = stubBrowserWindow('app.sajidaliai.online');
    completeAuthRedirect('https://sajidali.app.sajidaliai.online/schedule', {
      id: 'u1',
      email: 'sajidali@protonsemail.com',
      subdomain: 'sajidali',
    });
    expect(location.href).toBe('https://sajidali.app.sajidaliai.online/schedule');
  });

  it('builds a white-label tenant URL from a relative redirect', () => {
    const location = stubBrowserWindow('app.sajidaliai.online');
    completeAuthRedirect('/schedule', {
      id: 'u1',
      email: 'sajidali@protonsemail.com',
      subdomain: 'sajidali',
    });
    expect(location.href).toBe('https://sajidali.app.sajidaliai.online/schedule');
  });

  it('rejects a fbuploadpro returnUrl on a white-label login', () => {
    const location = stubBrowserWindow('app.sajidaliai.online');
    completeAuthRedirect('https://sajidali.fbuploadpro.com/', {
      id: 'u1',
      email: 'sajidali@protonsemail.com',
      subdomain: 'sajidali',
    });
    expect(location.href).toBe('https://sajidali.app.sajidaliai.online/');
  });

  it('keeps a fbuploadpro login on the fbuploadpro tenant host', () => {
    const location = stubBrowserWindow('app.fbuploadpro.com');
    completeAuthRedirect('https://sajidali.fbuploadpro.com/', {
      id: 'u1',
      email: 'sajidali@fbuploadpro.com',
      subdomain: 'sajidali',
    });
    expect(location.href).toBe('https://sajidali.fbuploadpro.com/');
  });

  it('rejects a white-label returnUrl on a fbuploadpro login', () => {
    const location = stubBrowserWindow('app.fbuploadpro.com');
    completeAuthRedirect('https://sajidali.app.sajidaliai.online/', {
      id: 'u1',
      email: 'sajidali@fbuploadpro.com',
      subdomain: 'sajidali',
    });
    expect(location.href).toBe('https://sajidali.fbuploadpro.com/');
  });
});
