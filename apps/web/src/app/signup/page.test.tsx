/** @vitest-environment jsdom */
/**
 * Signup + OTP — behavioural tests for the form-standard conversion
 * (spec 136 PR-136B). User-event driven against the REAL typed API
 * client: only the network (`fetch`) and the post-auth navigation
 * (`completeAuthRedirect`) are doubled, so response-schema validation,
 * server-error mapping and the cooldown handling are production paths.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configure, render, screen, waitFor } from "@testing-library/react";

// The five-field form types far more keystrokes than the login suite's
// two fields; on a loaded machine the default 5s test / 1s finder
// budgets expire before the interactions finish.
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 15_000 });
import userEvent from "@testing-library/user-event";
import SignupPage, { validateSignupDetails } from "./page";
import { SignupFlow } from "@/components/auth/signup-flow";
import { resetSessionExpiredGuard } from "@/lib/api/session-expired";

const completeAuthRedirect = vi.fn();
vi.mock("@/lib/auth-broadcast", () => ({
  completeAuthRedirect: (...args: unknown[]) => completeAuthRedirect(...args),
}));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setUrl(path: string) {
  window.history.pushState({}, "", path);
}

const VALID = {
  name: "Jane Doe",
  phone: "+1 202 555 0199",
  email: "jane.doe@gmail.com",
  password: "correct-password",
};

async function fillDetails(
  user: ReturnType<typeof userEvent.setup>,
  overrides: Partial<typeof VALID & { confirmPassword: string }> = {}
) {
  const values = { confirmPassword: VALID.password, ...VALID, ...overrides };
  await user.type(screen.getByLabelText("Full Name"), values.name);
  await user.type(screen.getByLabelText("Phone Number"), values.phone);
  await user.type(screen.getByLabelText("Email Address"), values.email);
  await user.type(screen.getByLabelText("Password", { exact: true }), values.password);
  await user.type(screen.getByLabelText("Confirm Password"), values.confirmPassword);
}

async function submitDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Create Account" }));
}

const SIGNUP_SUCCESS = {
  success: true,
  requiresOtp: true,
  cooldownSecondsRemaining: 60,
  email: VALID.email,
  message: "A 6-digit verification code has been sent to your Gmail address.",
};

const VERIFY_SUCCESS = {
  success: true,
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    email: VALID.email,
    name: VALID.name,
    subdomain: "janedoe",
    role: "admin",
    status: "active",
  },
  redirectUrl: "/tenant/janedoe",
};

beforeEach(() => {
  completeAuthRedirect.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetSessionExpiredGuard();
  setUrl("/signup");
  delete process.env.NEXT_PUBLIC_SIGNUPS_ENABLED;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_SIGNUPS_ENABLED;
});

describe("signup details form (form standard)", () => {
  it("renders the create-account copy, fields and credential attributes", () => {
    render(<SignupFlow />);
    expect(screen.getByRole("heading", { name: "Create Account" })).toBeTruthy();
    expect(screen.getByLabelText("Full Name")).toBeTruthy();
    expect(screen.getByLabelText("Phone Number")).toBeTruthy();
    expect(screen.getByLabelText("Email Address")).toBeTruthy();
    expect(screen.getByLabelText("Password", { exact: true })).toBeTruthy();
    expect(screen.getByLabelText("Confirm Password")).toBeTruthy();
    expect(screen.getByText("Only @gmail.com (or @googlemail.com) accounts are supported.")).toBeTruthy();
    expect(screen.getByText("Minimum 8 characters")).toBeTruthy();
    const password = screen.getByLabelText("Password", { exact: true }) as HTMLInputElement;
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    expect(password.type).toBe("password");
    // Show/hide is offered on both password fields (Rule 28).
    expect(screen.getAllByRole("button", { name: "Show password" })).toHaveLength(2);
  });

  it("empty submit shows every field error inline only, once each, with no request", async () => {
    const user = userEvent.setup();
    render(<SignupFlow />);
    await submitDetails(user);

    expect(await screen.findAllByText("Full name is required.")).toHaveLength(1);
    expect(screen.getAllByText("Phone number is required.")).toHaveLength(1);
    expect(screen.getAllByText("A valid email address is required.")).toHaveLength(1);
    expect(screen.getAllByText("Password is required.")).toHaveLength(1);
    expect(screen.getAllByText("Please confirm your password.")).toHaveLength(1);
    expect(document.querySelector('[data-slot="form-error-summary"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates on blur: a non-Gmail address errors inline without a summary or a request", async () => {
    const user = userEvent.setup();
    render(<SignupFlow />);
    const email = screen.getByLabelText("Email Address");
    await user.click(email);
    await user.type(email, "jane@example.com");
    await user.click(screen.getByLabelText("Full Name"));

    expect(
      await screen.findByText("Registration is limited to @gmail.com (or @googlemail.com) accounts.")
    ).toBeTruthy();
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[data-slot="form-error-summary"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("partially wrong submit: short password and mismatched confirmation surface with §3.3 wording, input preserved", async () => {
    const user = userEvent.setup();
    render(<SignupFlow />);
    await fillDetails(user, { password: "short", confirmPassword: "different-1" });
    await submitDetails(user);

    expect(await screen.findAllByText("Password must be at least 8 characters long.")).toHaveLength(1);
    expect(
      screen.getAllByText("Passwords do not match. Enter the same password in both fields.")
    ).toHaveLength(1);
    expect((screen.getByLabelText("Email Address") as HTMLInputElement).value).toBe(VALID.email);
    expect((screen.getByLabelText("Password", { exact: true }) as HTMLInputElement).value).toBe("short");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("server 400 field errors map back onto the fields inline only", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: "Validation failed",
        details: { email: ["This email address cannot be used."] },
      })
    );
    render(<SignupFlow />);
    await fillDetails(user);
    await submitDetails(user);

    expect(await screen.findAllByText("This email address cannot be used.")).toHaveLength(1);
    expect(screen.getByLabelText("Email Address").getAttribute("aria-invalid")).toBe("true");
  });

  it("already-registered conflict offers Sign in instead and Reset password in place", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: "This email is already registered." })
    );
    render(<SignupFlow />);
    await fillDetails(user);
    await submitDetails(user);

    expect(await screen.findAllByText("This email is already registered.")).toHaveLength(1);
    const signIn = screen.getByRole("link", { name: "Sign in instead" });
    expect(signIn.getAttribute("href")).toBe(
      `/login?email=${encodeURIComponent(VALID.email)}`
    );
    const reset = screen.getByRole("link", { name: "Reset password" });
    expect(reset.getAttribute("href")).toBe(
      `/forgot-password?email=${encodeURIComponent(VALID.email)}`
    );
  });

  it("email-budget rate limit surfaces the plain message with no countdown and the submit stays enabled", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(429, {
        error:
          "We couldn't send your verification code right now because email sending is temporarily at its limit. Please try again in a little while.",
        emailRateLimited: true,
      })
    );
    render(<SignupFlow />);
    await fillDetails(user);
    await submitDetails(user);

    expect(
      await screen.findByText(
        "We couldn't send your verification code right now because email sending is temporarily at its limit. Please try again in a little while."
      )
    ).toBeTruthy();
    // No invented countdown: the submit keeps its normal label and stays enabled.
    const button = screen.getByRole("button", { name: "Create Account" });
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("rate-limited signup surfaces the wait message and disables the submit with its countdown", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(429, {
        error: "Too many registration attempts. Please wait 45 seconds before trying again.",
        retryAfterSeconds: 45,
      })
    );
    render(<SignupFlow />);
    await fillDetails(user);
    await submitDetails(user);

    expect(
      await screen.findByText(
        "Too many registration attempts. Please wait 45 seconds before trying again."
      )
    ).toBeTruthy();
    const button = screen.getByRole("button", { name: /Please wait 45s/ });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("network failure surfaces the connection message as a plain inline line, never silently", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    render(<SignupFlow />);
    await fillDetails(user);
    await submitDetails(user);

    expect(
      await screen.findByText(
        "Couldn't create your account. Please check your connection and try again."
      )
    ).toBeTruthy();
  });

  it("successful details submit moves to the OTP step naming the email, with the resend cooling down", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, SIGNUP_SUCCESS));
    render(<SignupFlow />);
    await fillDetails(user);
    await submitDetails(user);

    expect(await screen.findByRole("heading", { name: "Verify Your Email" })).toBeTruthy();
    expect(screen.getByText(VALID.email)).toBeTruthy();
    const otp = screen.getByLabelText("6-Digit Verification Code") as HTMLInputElement;
    expect(otp.getAttribute("autocomplete")).toBe("one-time-code");
    const resend = screen.getByRole("button", { name: "Resend code in 60s" });
    expect(resend.hasAttribute("disabled")).toBe(true);
  });
});

describe("signup OTP step (§5.4 pattern)", () => {
  async function gotoOtpStep(user: ReturnType<typeof userEvent.setup>) {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, SIGNUP_SUCCESS));
    render(<SignupFlow />);
    await fillDetails(user);
    await submitDetails(user);
    return screen.findByLabelText("6-Digit Verification Code");
  }

  it("pastes the code whole, verifies, and hands off through completeAuthRedirect", async () => {
    const user = userEvent.setup();
    const otpField = (await gotoOtpStep(user)) as HTMLInputElement;
    fetchMock.mockResolvedValueOnce(jsonResponse(201, VERIFY_SUCCESS));

    await user.click(otpField);
    await user.paste("123456");
    expect(otpField.value).toBe("123456");

    await user.click(screen.getByRole("button", { name: "Verify & Activate Account" }));
    await waitFor(() =>
      expect(completeAuthRedirect).toHaveBeenCalledWith("/tenant/janedoe", VERIFY_SUCCESS.user)
    );
    const verifyCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/auth/signup/verify-otp")
    );
    expect(verifyCall).toBeTruthy();
    const [, init] = verifyCall as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      email: VALID.email,
      otp: "123456",
      returnUrl: undefined,
    });
  });

  it("strips non-digits as the code is typed", async () => {
    const user = userEvent.setup();
    const otpField = (await gotoOtpStep(user)) as HTMLInputElement;
    await user.type(otpField, "a1b2c3");
    expect(otpField.value).toBe("123");
  });

  it("incomplete code errors with §3.3 wording and makes no verify request", async () => {
    const user = userEvent.setup();
    const otpField = await gotoOtpStep(user);
    await user.type(otpField, "123");
    await user.click(screen.getByRole("button", { name: "Verify & Activate Account" }));

    expect(
      await screen.findAllByText("Enter the full 6-digit code.")
    ).toHaveLength(1);
    const verifyCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("verify-otp")
    );
    expect(verifyCalls).toHaveLength(0);
  });

  it("expired-code error reveals Resend code in place", async () => {
    const user = userEvent.setup();
    const otpField = await gotoOtpStep(user);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: "Verification code has expired. Please request a new one." })
    );
    await user.type(otpField, "123456");
    await user.click(screen.getByRole("button", { name: "Verify & Activate Account" }));

    // Inline under the field only — no summary box duplicating it.
    expect(
      await screen.findAllByText("Verification code has expired. Please request a new one.")
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Resend code" })).toBeTruthy();
  });

  it("direct OTP entry via ?step=otp resends on demand and confirms with the Code Sent callout", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, message: "sent" }));
    // Entry params now arrive as server-page props, not window.location.
    render(<SignupFlow initialStep="otp" initialEmail={VALID.email} />);

    const resend = await screen.findByRole("button", { name: "Did not receive code? Resend" });
    expect(resend.hasAttribute("disabled")).toBe(false);
    await user.click(resend);

    expect(
      await screen.findByText(
        "A new 6-digit code has been sent to your email."
      )
    ).toBeTruthy();
    expect(screen.getByText("Code Sent")).toBeTruthy();
    const cooled = screen.getByRole("button", { name: "Resend code in 60s" });
    expect(cooled.hasAttribute("disabled")).toBe(true);
  });

  it("email-budget resend failure shows the plain message with no cooldown and keeps resend usable", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(429, {
        error:
          "We couldn't send your verification code right now because email sending is temporarily at its limit. Please try again in a little while.",
        emailRateLimited: true,
      })
    );
    render(<SignupFlow initialStep="otp" initialEmail={VALID.email} />);

    const resend = await screen.findByRole("button", { name: "Did not receive code? Resend" });
    await user.click(resend);

    expect(
      await screen.findByText(
        "We couldn't send your verification code right now because email sending is temporarily at its limit. Please try again in a little while."
      )
    ).toBeTruthy();
    // No invented countdown: resend keeps its normal label and stays enabled.
    const resendAfter = screen.getByRole("button", { name: "Did not receive code? Resend" });
    expect(resendAfter.hasAttribute("disabled")).toBe(false);
  });

  it("pending-verification entry shows the fresh-code notice on the details step", async () => {
    render(
      <SignupFlow
        initialEmail={VALID.email}
        initialSuccessNotice="We sent a 6-digit code to your email. Enter it below to finish signing up."
      />
    );
    expect(
      await screen.findByText(
        "We sent a 6-digit code to your email. Enter it below to finish signing up."
      )
    ).toBeTruthy();
    expect((screen.getByLabelText("Email Address") as HTMLInputElement).value).toBe(VALID.email);
  });
});

describe("signup paused gate — server-side (§4.2.4)", () => {
  it("renders the form when signups are enabled", async () => {
    render(await SignupPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("heading", { name: "Create Account" })).toBeTruthy();
    expect(screen.getByLabelText("Full Name")).toBeTruthy();
    expect(screen.queryByText("New registrations are paused for now")).toBeNull();
  });

  it("replaces the details step with the paused card only, no form, when signups are disabled", async () => {
    process.env.NEXT_PUBLIC_SIGNUPS_ENABLED = "false";
    // The gate is server-side: the paused render must contain no form
    // at all — no fields, no submit — so there is nothing to flash
    // into and no 403 can follow a form the user should never see.
    render(await SignupPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("heading", { name: "Registration Paused" })).toBeTruthy();
    expect(screen.getByText("New registrations are paused for now")).toBeTruthy();
    // Card button + layout footer now share the "Sign in" label (copy
    // unification); both point at /login.
    expect(
      screen.getAllByRole("link", { name: "Sign in" }).map((l) => l.getAttribute("href"))
    ).toEqual(["/login", "/login"]);
    expect(screen.queryByLabelText("Full Name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create Account" })).toBeNull();
  });

  it("keeps the OTP step completable while signups are paused", async () => {
    process.env.NEXT_PUBLIC_SIGNUPS_ENABLED = "false";
    render(
      await SignupPage({
        searchParams: Promise.resolve({ step: "otp", email: VALID.email }),
      })
    );
    expect(await screen.findByLabelText("6-Digit Verification Code")).toBeTruthy();
    expect(screen.queryByText("New registrations are paused for now")).toBeNull();
  });

  it("paused OTP step: Edit your details lands on the paused card, never the details form", async () => {
    const user = userEvent.setup();
    render(
      <SignupFlow initialStep="otp" initialEmail={VALID.email} initialIsPaused />
    );
    expect(await screen.findByLabelText("6-Digit Verification Code")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Need to change your details? Edit your details" })
    );
    expect(screen.getByRole("heading", { name: "Registration Paused" })).toBeTruthy();
    expect(screen.getByText("New registrations are paused for now")).toBeTruthy();
    expect(screen.queryByLabelText("Full Name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create Account" })).toBeNull();
  });

  it("paused OTP step: Wrong email? Edit lands on the paused card, never the details form", async () => {
    const user = userEvent.setup();
    render(
      <SignupFlow initialStep="otp" initialEmail={VALID.email} initialIsPaused />
    );
    expect(await screen.findByLabelText("6-Digit Verification Code")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Wrong email? Edit" }));
    expect(screen.getByRole("heading", { name: "Registration Paused" })).toBeTruthy();
    expect(screen.getByText("New registrations are paused for now")).toBeTruthy();
    expect(screen.queryByLabelText("Full Name")).toBeNull();
  });

  it("paused OTP step via the server page: Edit your details lands on the paused card", async () => {
    const user = userEvent.setup();
    process.env.NEXT_PUBLIC_SIGNUPS_ENABLED = "false";
    render(
      await SignupPage({
        searchParams: Promise.resolve({ step: "otp", email: VALID.email }),
      })
    );
    expect(await screen.findByLabelText("6-Digit Verification Code")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Need to change your details? Edit your details" })
    );
    expect(screen.getByRole("heading", { name: "Registration Paused" })).toBeTruthy();
    expect(screen.queryByLabelText("Full Name")).toBeNull();
  });
});

describe("validateSignupDetails (schema-backed parity helper)", () => {
  it("accepts a valid payload and reports §3.3 wording for an invalid one", () => {
    expect(validateSignupDetails({ ...VALID, confirmPassword: VALID.password })).toEqual({});
    const errors = validateSignupDetails({
      name: "",
      phone: "",
      email: "jane@example.com",
      password: "short",
      confirmPassword: "different-1",
    });
    expect(errors.name).toBe("Full name is required.");
    expect(errors.phone).toBe("Phone number is required.");
    expect(errors.email).toBe(
      "Registration is limited to @gmail.com (or @googlemail.com) accounts."
    );
    expect(errors.password).toBe("Password must be at least 8 characters long.");
    expect(errors.confirmPassword).toBe(
      "Passwords do not match. Enter the same password in both fields."
    );
  });
});
