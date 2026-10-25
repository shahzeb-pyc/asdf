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
      description: 'New registrations are paused for now.',
    };
  }
  if (step === 'details') {
    return {
      title: 'Create Account',
      description: 'Create your account to schedule and publish across your platforms.',
    };
  }
  return {
    title: 'Verify Your Email',
    description: `We've sent a 6-digit verification code to ${email}. Enter the code below to activate your account.`,
  };
}
