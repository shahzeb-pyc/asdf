import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../../src/middleware';
import { isMaintenanceMode, isMaintenanceExemptPath } from '../../src/lib/maintenance';

function requestFor(url: string, host: string): NextRequest {
  return new NextRequest(url, { headers: { host } });
}

describe('Maintenance mode (spec 209)', () => {
  const originalFlag = process.env.MAINTENANCE_MODE;

  beforeAll(() => {
    process.env.NEXT_PUBLIC_ROOT_DOMAIN = 'localhost:3000';
  });

  beforeEach(() => {
    process.env.MAINTENANCE_MODE = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.MAINTENANCE_MODE;
    else process.env.MAINTENANCE_MODE = originalFlag;
  });

  describe('isMaintenanceMode()', () => {
    it('is on only for the exact lowercase value true', () => {
      process.env.MAINTENANCE_MODE = 'true';
      expect(isMaintenanceMode()).toBe(true);
      process.env.MAINTENANCE_MODE = 'false';
      expect(isMaintenanceMode()).toBe(false);
      process.env.MAINTENANCE_MODE = 'TRUE';
      expect(isMaintenanceMode()).toBe(false);
      process.env.MAINTENANCE_MODE = '1';
      expect(isMaintenanceMode()).toBe(false);
      process.env.MAINTENANCE_MODE = '';
      expect(isMaintenanceMode()).toBe(false);
      delete process.env.MAINTENANCE_MODE;
      expect(isMaintenanceMode()).toBe(false);
    });
  });

  describe('isMaintenanceExemptPath()', () => {
    it('exempts the maintenance page itself, /api/*, /_next/*, and static assets', () => {
      expect(isMaintenanceExemptPath('/maintenance')).toBe(true);
      expect(isMaintenanceExemptPath('/api/auth/session')).toBe(true);
      expect(isMaintenanceExemptPath('/api')).toBe(true);
      expect(isMaintenanceExemptPath('/_next/static/chunk.js')).toBe(true);
      expect(isMaintenanceExemptPath('/favicon.ico')).toBe(true);
      expect(isMaintenanceExemptPath('/robots.txt')).toBe(true);
      expect(isMaintenanceExemptPath('/sitemap.xml')).toBe(true);
      expect(isMaintenanceExemptPath('/login')).toBe(false);
      expect(isMaintenanceExemptPath('/schedule')).toBe(false);
      expect(isMaintenanceExemptPath('/privacy')).toBe(false);
    });
  });

  describe('flag on', () => {
    it('rewrites a login request on the app host to /maintenance', async () => {
      const res = await middleware(
        requestFor('http://app.localhost:3000/login', 'app.localhost:3000')
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-rewrite')).toContain('/maintenance');
    });

    it('rewrites a tenant page request to /maintenance', async () => {
      const res = await middleware(
        requestFor('http://acme.localhost:3000/schedule', 'acme.localhost:3000')
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-rewrite')).toContain('/maintenance');
    });

    it('rewrites on the white-label host too', async () => {
      const res = await middleware(
        requestFor(
          'http://sajidali.sajidaliai.online/schedule',
          'sajidali.sajidaliai.online'
        )
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-rewrite')).toContain('/maintenance');
    });

    it('rewrites /privacy too — only the spec exclusions escape', async () => {
      const res = await middleware(
        requestFor('http://acme.localhost:3000/privacy', 'acme.localhost:3000')
      );
      expect(res.headers.get('x-middleware-rewrite')).toContain('/maintenance');
    });

    it('serves /maintenance itself without rewriting', async () => {
      const res = await middleware(
        requestFor('http://app.localhost:3000/maintenance', 'app.localhost:3000')
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    });

    it('leaves /api/* unaffected', async () => {
      const res = await middleware(
        requestFor('http://app.localhost:3000/api/auth/session', 'app.localhost:3000')
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    });

    it('leaves static assets unaffected', async () => {
      const res = await middleware(
        requestFor('http://app.localhost:3000/favicon.ico', 'app.localhost:3000')
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    });
  });

  describe('flag off', () => {
    beforeEach(() => {
      delete process.env.MAINTENANCE_MODE;
    });

    it('renders the app normally — login serves, no rewrite', async () => {
      const res = await middleware(
        requestFor('http://app.localhost:3000/login', 'app.localhost:3000')
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
      expect(res.headers.get('location')).toBeNull();
    });

    it('tenant routing resumes — no session bounces to login', async () => {
      const res = await middleware(
        requestFor('http://acme.localhost:3000/schedule', 'acme.localhost:3000')
      );
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toContain('/login');
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    });
  });
});
