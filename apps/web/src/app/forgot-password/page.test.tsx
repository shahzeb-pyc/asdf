/** @vitest-environment jsdom */
/**
 * Password recovery — behavioural tests for the form-standard
 * conversion (spec 136 PR-136C). User-event driven against the REAL
 * typed API client: only the network (`fetch`) and the router are
 * doubled, so response-schema validation, server-error mapping, the
 * resend cooldown and the timed redirect are production paths.
 *
 * Expectations' semantics are the preserved behaviours of spec 136
 * §4.3 / §3.3 — the same copy and outcomes the previous hand-rolled
 * forms produced.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 15_000 });
import userEvent from "@testing-library/user-event";
import ForgotPasswordPage from "./page";
import { resetSessionExpiredGuard } from "@/lib/api/session-expired";

const routerPush = vi.fn();
const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
}));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EMAIL = "jane.doe@gmail.com";
const NEW_PASSWORD = "correct-new-password";

const FORGOT_SUCCESS = {
  success: true,
  requiresOtp: true,
  email: EMAIL,
  message: `A 6-digit verification code has been sent to ${EMAIL}.`,
};

function mockApiByPath(handlers: Record<string, (status?: number) => Response>) {
  fetchMock.mockImplementation(async (url: unknown) => {
    const path = String(url);
    for (const [fragment, handler] of Object.entries(handlers)) {
      if (path.includes(fragment)) return handler();
    }
    throw new Error(`Unmocked fetch: ${path}`);
  });
}

async function gotoStep2(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Email Address"), EMAIL);
  await user.click(screen.getByRole("button", { name: "Send Verification Code" }));
  return screen.findByLabelText("Verification Code");
}

beforeEach(() => {
  routerPush.mockClear();
  routerReplace.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetSessionExpiredGuard();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("forgot-password step 1 (email)", () => {
  it("renders the reset copy, field, helper and credential attributes", () => {
    render(<ForgotPasswordPage />);
    expect(screen.getByRole("heading", { name: "Reset Password" })).toBeTruthy();
    expect(
      screen.getByText("Enter your registered Gmail address to receive a 6-digit verification code.")
    ).toBeTruthy();
    const email = screen.getByLabelText("Email Address") as HTMLInputElement;
    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("email");
    expect(
      screen.getByText(
        "We will send a 6-digit verification code to your registered Gmail address."
      )
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("empty submit shows the Gmail error inline only, with no request", async () => {
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));

    expect(await screen.findAllByText("Please enter a valid Gmail address.")).toHaveLength(1);
    expect(document.querySelector('[data-slot="form-error-summary"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("non-Gmail address shows the recovery-availability wording and makes no request", async () => {
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText("Email Address"), "operator@example.com");
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));

    expect(
      await screen.findAllByText(
        "Password recovery is available for @gmail.com (or @googlemail.com) accounts."
      )
    ).toHaveLength(1);
    // Input is never cleared on a failed submit.
    expect((screen.getByLabelText("Email Address") as HTMLInputElement).value).toBe(
      "operator@example.com"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("server 400 maps its sanitized message onto the email field", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: "Only @gmail.com (or @googlemail.com) email addresses are permitted." })
    );
    render(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText("Email Address"), EMAIL);
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));

    expect(
      await screen.findAllByText(
        "Only @gmail.com (or @googlemail.com) email addresses are permitted."
      )
    ).toHaveLength(1);
  });

  it("network failure surfaces as a plain inline line, never silently", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText("Email Address"), EMAIL);
    await user.click(screen.getByRole("button", { name: "Send Verification Code" }));

    expect(
      await screen.findByText(
        "Couldn't process your request. Please check your connection and try again."
      )
    ).toBeTruthy();
  });

  it("does not prefill from a ?email= parameter (OD-136-7 not approved)", async () => {
    window.history.pushState({}, "", "/forgot-password?email=prefill@gmail.com");
    render(<ForgotPasswordPage />);
    expect((screen.getByLabelText("Email Address") as HTMLInputElement).value).toBe("");
    window.history.pushState({}, "", "/forgot-password");
  });
});

describe("forgot-password step 2 (code + new password)", () => {
  it("names the destination email, carries the OTP pattern, and starts the resend cooldown", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, FORGOT_SUCCESS));
    render(<ForgotPasswordPage />);
    const otp = (await gotoStep2(user)) as HTMLInputElement;

    expect(screen.getByRole("heading", { name: "Set New Password" })).toBeTruthy();
    expect(
      screen.getByText(`Enter the 6-digit verification code sent to ${EMAIL} and your new password.`)
    ).toBeTruthy();
    expect(otp.getAttribute("autocomplete")).toBe("one-time-code");
    expect(otp.getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByText("Enter the 6-digit numeric code sent to your email.")).toBeTruthy();
    expect(screen.getByText("Minimum 8 characters")).toBeTruthy();
    // Resend starts disabled with the countdown as its label (§4.3.2).
    const resend = screen.getByRole("button", { name: "Resend code (60s)" });
    expect(resend.hasAttribute("disabled")).toBe(true);
    // Show/hide on both password fields (Rule 28).
    expect(screen.getAllByRole("button", { name: "Show password" })).toHaveLength(2);
    const password = screen.getByLabelText("New Password", { exact: true }) as HTMLInputElement;
    expect(password.getAttribute("autocomplete")).toBe("new-password");
  });

  it("pastes the code whole, resets, shows the success state and redirects after 2,000 ms", async () => {
    const user = userEvent.setup();
    mockApiByPath({
      "/api/auth/reset-password": () =>
        jsonResponse(200, { success: true, message: "Your password has been successfully updated." }),
      "/api/auth/forgot-password": () => jsonResponse(200, FORGOT_SUCCESS),
    });
    render(<ForgotPasswordPage />);
    const otp = (await gotoStep2(user)) as HTMLInputElement;

    await user.click(otp);
    await user.paste("123456");
    expect(otp.value).toBe("123456");
    await user.type(screen.getByLabelText("New Password", { exact: true }), NEW_PASSWORD);
    await user.type(screen.getByLabelText("Confirm New Password"), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Update Password" }));

    expect(await screen.findByText("Password Updated")).toBeTruthy();
    expect(
      screen.getByText("Your password has been successfully reset. Redirecting you to sign in...")
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Proceed to Sign In" }).getAttribute("href")).toBe(
      "/login?reset=success"
    );
    const resetCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/api/auth/reset-password")
    );
    expect(resetCall).toBeTruthy();
    // The timed redirect (§4.3.3) fires after 2,000 ms.
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/login?reset=success"), {
      timeout: 5_000,
    });
  });

  it("empty submit shows every step-2 error inline only, with no request", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, FORGOT_SUCCESS));
    render(<ForgotPasswordPage />);
    await gotoStep2(user);
    fetchMock.mockClear();

    await user.click(screen.getByRole("button", { name: "Update Password" }));
    expect(await screen.findAllByText("Verification code is required.")).toHaveLength(1);
    expect(screen.getAllByText("New password is required.")).toHaveLength(1);
    expect(screen.getAllByText("Please confirm your new password.")).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("short code, short password and mismatched confirmation use the preserved wording", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, FORGOT_SUCCESS));
    render(<ForgotPasswordPage />);
    const otp = await gotoStep2(user);
    await user.type(otp, "123");
    await user.type(screen.getByLabelText("New Password", { exact: true }), "short");
    await user.type(screen.getByLabelText("Confirm New Password"), "different-password");
    await user.click(screen.getByRole("button", { name: "Update Password" }));

    expect(await screen.findAllByText("Verification code must be exactly 6 digits.")).toHaveLength(1);
    expect(screen.getAllByText("Password must be at least 8 characters long.")).toHaveLength(1);
    expect(
      screen.getAllByText("Passwords do not match. Please verify both password fields.")
    ).toHaveLength(1);
  });

  it("server code failure maps onto the code field", async () => {
    const user = userEvent.setup();
    mockApiByPath({
      "/api/auth/reset-password": () =>
        jsonResponse(400, { error: "Invalid or expired verification code." }),
      "/api/auth/forgot-password": () => jsonResponse(200, FORGOT_SUCCESS),
    });
    render(<ForgotPasswordPage />);
    const otp = await gotoStep2(user);
    await user.type(otp, "123456");
    await user.type(screen.getByLabelText("New Password", { exact: true }), NEW_PASSWORD);
    await user.type(screen.getByLabelText("Confirm New Password"), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Update Password" }));

    expect(await screen.findAllByText("Invalid or expired verification code.")).toHaveLength(1);
    // Entered values survive the failed submit.
    expect((screen.getByLabelText("Verification Code") as HTMLInputElement).value).toBe("123456");
  });

  it("resend unlocks after the 60-second cooldown and confirms the fresh code", async () => {
    // Fake timers drive the countdown; interactions use fireEvent
    // (userEvent's internal delays deadlock against fake timers).
    vi.useFakeTimers();
    try {
      mockApiByPath({
        "/api/auth/forgot-password/resend": () =>
          jsonResponse(200, { success: true, message: "sent" }),
        "/api/auth/forgot-password": () => jsonResponse(200, FORGOT_SUCCESS),
      });
      render(<ForgotPasswordPage />);
      fireEvent.change(screen.getByLabelText("Email Address"), { target: { value: EMAIL } });
      fireEvent.click(screen.getByRole("button", { name: "Send Verification Code" }));
      await act(async () => {});

      expect(screen.getByRole("heading", { name: "Set New Password" })).toBeTruthy();
      const cooling = screen.getByRole("button", { name: "Resend code (60s)" });
      expect(cooling.hasAttribute("disabled")).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      const resend = screen.getByRole("button", { name: "Resend code" });
      expect(resend.hasAttribute("disabled")).toBe(false);

      fireEvent.click(resend);
      await act(async () => {});
      expect(
        screen.getByText("We've sent a fresh code. Any earlier codes no longer work.")
      ).toBeTruthy();
      const recooled = screen.getByRole("button", { name: "Resend code (60s)" });
      expect(recooled.hasAttribute("disabled")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Change email address returns to step 1 with the email preserved", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, FORGOT_SUCCESS));
    render(<ForgotPasswordPage />);
    await gotoStep2(user);

    await user.click(screen.getByRole("button", { name: "Change email address" }));
    expect(await screen.findByRole("heading", { name: "Reset Password" })).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText("Email Address") as HTMLInputElement).value).toBe(EMAIL)
    );
  });
});
