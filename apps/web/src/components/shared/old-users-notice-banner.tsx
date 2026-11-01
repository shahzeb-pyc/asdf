import * as React from 'react';
import { Banner } from '@/components/shared/ui/banner';

/**
 * Old-users migration notice (owner's words, Roman Urdu, standard
 * spelling + minimal punctuation for readability).
 *
 * Fresh-start context: old fbuploadpro users must create a new
 * account, then message the owner on WhatsApp so he can transfer
 * their tokens across. Shown on the login screen and the logged-in
 * Home dashboard — and nowhere else.
 */
export const OLD_USERS_NOTICE_TEXT =
  'Old fbuploadpro users, new account create karein aur mujhe WhatsApp par message karein jo neechay show ho raha hai, main aapke tokens idhar transfer karta hoon.';

/**
 * Persistent, non-dismissible notice banner. Text only by owner
 * direction: no phone number, no WhatsApp link, no button — the
 * app's bottom-corner WhatsApp icon is the contact route.
 */
export function OldUsersNoticeBanner() {
  return (
    <Banner
      data-testid="old-users-notice-banner"
      variant="warning"
      title={OLD_USERS_NOTICE_TEXT}
    />
  );
}
