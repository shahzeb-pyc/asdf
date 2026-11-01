/**
 * Facebook scope check — the comparison behind hard scope rejection.
 *
 * An account must grant all five requested scopes before anything is
 * saved; a declined, absent, or oddly-statused scope is missing, and
 * the rejection names the missing scope in plain language.
 */
import { describe, expect, it } from 'vitest';
import {
  buildScopeRejectionMessage,
  findMissingScopes,
  parseFacebookPermissions,
  parseMissingScopesParam,
} from '@/lib/facebook-permissions';

const ALL_GRANTED = [
  { permission: 'pages_show_list', status: 'granted' },
  { permission: 'pages_read_engagement', status: 'granted' },
  { permission: 'pages_manage_posts', status: 'granted' },
  { permission: 'pages_manage_engagement', status: 'granted' },
  { permission: 'business_management', status: 'granted' },
];

describe('findMissingScopes', () => {
  it('reports nothing missing when all five scopes are granted', () => {
    expect(findMissingScopes(ALL_GRANTED)).toEqual([]);
  });

  it('reports a declined scope as missing', () => {
    const permissions = ALL_GRANTED.map((entry) =>
      entry.permission === 'pages_manage_posts'
        ? { ...entry, status: 'declined' }
        : entry
    );
    expect(findMissingScopes(permissions)).toEqual(['pages_manage_posts']);
  });

  it('reports an absent scope as missing', () => {
    const permissions = ALL_GRANTED.filter(
      (entry) => entry.permission !== 'business_management'
    );
    expect(findMissingScopes(permissions)).toEqual(['business_management']);
  });

  it('never treats an unknown status as granted', () => {
    const permissions = ALL_GRANTED.map((entry) =>
      entry.permission === 'pages_show_list'
        ? { ...entry, status: 'unknown_status' }
        : entry
    );
    expect(findMissingScopes(permissions)).toEqual(['pages_show_list']);
  });

  it('ignores unrelated permissions and treats a missing list as all missing', () => {
    expect(
      findMissingScopes([{ permission: 'public_profile', status: 'granted' }])
    ).toHaveLength(5);
    expect(findMissingScopes(null)).toHaveLength(5);
    expect(findMissingScopes(undefined)).toHaveLength(5);
  });
});

describe('buildScopeRejectionMessage', () => {
  it('names the actually missing scope in plain language, not just posting', () => {
    expect(buildScopeRejectionMessage(['pages_manage_posts'])).toBe(
      'This Facebook account was not connected. A required permission — posting to Pages — was declined. Please reconnect and allow all requested permissions to continue.'
    );
  });

  it('names every missing scope when more than one is declined', () => {
    expect(
      buildScopeRejectionMessage(['pages_show_list', 'business_management'])
    ).toBe(
      'This Facebook account was not connected. Required permissions — viewing your Pages and managing your business — were declined. Please reconnect and allow all requested permissions to continue.'
    );
  });
});

describe('parseFacebookPermissions / parseMissingScopesParam', () => {
  it('extracts the data list and rejects malformed payloads', () => {
    expect(parseFacebookPermissions({ data: ALL_GRANTED })).toEqual(ALL_GRANTED);
    expect(parseFacebookPermissions({ data: 'nope' })).toEqual([]);
    expect(parseFacebookPermissions(null)).toEqual([]);
  });

  it('keeps only recognised scopes from a redirect param', () => {
    expect(
      parseMissingScopesParam('pages_manage_posts,bogus_scope')
    ).toEqual(['pages_manage_posts']);
    expect(parseMissingScopesParam(null)).toEqual([]);
  });
});
