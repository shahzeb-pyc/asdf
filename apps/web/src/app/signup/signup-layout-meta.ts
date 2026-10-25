/**
 * Signup layout titles/descriptions per state. Pure helper, shared by
 * the server signup page (paused card) and the client signup flow —
 * kept in its own module so neither imports the other's component file.
 */
export function getSignupLayoutMeta(
  isPaused: boolean,
  step: 'details' | 'otp',
  email: string
): { title: string; description: string } {
  if (isPaused) {
    return {
      title: 'Registration Paused',
      description: 'We are currently not accepting new account registrations.',
    };
  }
  if (step === 'details') {
    return {
      title: 'Create Account',
      description: 'Start scheduling and auto-publishing Facebook Reels in minutes.',
    };
  }
  return {
    title: 'Verify Your Email',
    description: `We've sent a 6-digit confirmation code to ${email}. Enter the code below to activate your account.`,
  };
}
