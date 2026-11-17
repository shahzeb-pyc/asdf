import { describe, expect, it } from 'vitest';
import { buildMuseConnectPrompt, MUSE_CONNECT_PROMPT } from './muse.js';

/**
 * Brand-gated Connect Muse prompt (spec 191, owner reversal
 * 2026-11-15): the prompt names the brand and its guide address.
 * The negative control asserts the white-label prompt is exactly
 * our prompt with the brand name and guide address swapped — a
 * test that cannot fail would be theatre.
 */
describe('buildMuseConnectPrompt', () => {
  it('returns MUSE_CONNECT_PROMPT exactly on our brand', () => {
    expect(buildMuseConnectPrompt('fbuploadpro')).toBe(MUSE_CONNECT_PROMPT);
  });

  it('names NextRise Digital with the white-label guide address on nextrise', () => {
    const prompt = buildMuseConnectPrompt('nextrise');
    expect(prompt).toContain('Connect to my NextRise Digital account');
    expect(prompt).toContain('my NextRise Digital Media Library key');
    expect(prompt).toContain('https://app.sajidaliai.online/muse_guide.md');
    expect(prompt).toContain('my NextRise Digital sign-in');
    expect(prompt).not.toContain('FBUploadPro');
    expect(prompt).not.toContain('app.fbuploadpro.com');
  });

  it('negative control: the white-label prompt is our prompt with the brand swapped', () => {
    const prompt = buildMuseConnectPrompt('nextrise');
    expect(prompt).toBe(
      MUSE_CONNECT_PROMPT.split('FBUploadPro')
        .join('NextRise Digital')
        .split('https://app.fbuploadpro.com')
        .join('https://app.sajidaliai.online')
    );
  });
});
