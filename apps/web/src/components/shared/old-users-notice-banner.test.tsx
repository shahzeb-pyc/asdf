/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OldUsersNoticeBanner, OLD_USERS_NOTICE_TEXT } from './old-users-notice-banner';

describe('OldUsersNoticeBanner', () => {
  it('renders the owner migration notice as a persistent warning banner', () => {
    render(<OldUsersNoticeBanner />);
    const banner = screen.getByTestId('old-users-notice-banner');
    expect(banner.getAttribute('data-variant')).toBe('warning');
    expect(banner.textContent).toContain(OLD_USERS_NOTICE_TEXT);
    expect(OLD_USERS_NOTICE_TEXT).toBe(
      'Old fbuploadpro users, new account create karein aur mujhe WhatsApp par message karein jo neechay show ho raha hai, main aapke tokens idhar transfer karta hoon.'
    );
  });

  it('is text only: no dismiss control, no link, no button', () => {
    const { container } = render(<OldUsersNoticeBanner />);
    const banner = screen.getByTestId('old-users-notice-banner');
    expect(banner.querySelector('a')).toBeNull();
    expect(banner.querySelector('button')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});
