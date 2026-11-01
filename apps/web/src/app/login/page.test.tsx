/** @vitest-environment jsdom */
/**
 * Login form — behavioural tests for the §3.8 reference conversion
 * (spec 137 PR-A6). User-event driven against the REAL typed API
 * client: only the network (`fetch`) and the post-login navigation
 * (`completeAuthRedirect`) are doubled, so the 401 → session-expired
 * mapping, response-schema validation and error presentation are the
 * production code paths.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoginPage, { SESSION_EXPIRED_NOTICE, toApiReturnUrl } from "./page";
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

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, email: string, password: string) {
  await user.type(screen.getByLabelText("Email Address"), email);
  await user.type(screen.getByLabelText("Password", { exact: true }), password);
  await user.click(screen.getByRole("button", { name: "Sign In" }));
}

const SUCCESS_BODY = {
  success: true,
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    email: "owner@gmail.com",
    name: "Owner",
    subdomain: "e2e",
    role: "admin",
    status: "active",
  },
  redirectUrl: "/tenant/e2e",
};

beforeEach(() => {
  completeAuthRedirect.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  resetSessionExpiredGuard();
  setUrl("/login");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("login form (form standard reference conversion)", () => {
  it("renders the approved sign-in copy and fields", () => {
    render(<LoginPage />);
    expect(screen.getByRole("heading", { name: "Sign In" })).toBeTruthy();
    expect(
      screen.getByText("Welcome back. Sign in to your workspace.")
    ).toBeTruthy();
    expect(screen.getByLabelText("Email Address")).toBeTruthy();
    expect(screen.getByLabelText("Password", { exact: true })).toBeTruthy();
    expect(screen.getByText("Only @gmail.com (or @googlemail.com) accounts are supported.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Forgot password?" }).getAttribute("href")).toBe(
      "/forgot-password"
    );
    // No session-expired notice on a plain visit.
    expect(screen.queryByText(SESSION_EXPIRED_NOTICE)).toBeNull();
  });

  it('shows the old-users migration notice above the sign-in form, text only', () => {
    render(<LoginPage />);
    const banner = screen.getByTestId('old-users-notice-banner');
    expect(banner.textContent).toContain(
      'Old fbuploadpro users, new account create karein aur mujhe WhatsApp par message karein jo neechay show ho raha hai, main aapke tokens idhar transfer karta hoon.'
    );
    expect(banner.querySelector('a')).toBeNull();
    expect(banner.querySelector('button')).toBeNull();
    // The form itself is untouched and still present below the banner.
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeTruthy();
  });

  it("validates on blur: a non-Gmail address errors inline without a submit or a request", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    const email = screen.getByLabelText("Email Address");
    await user.click(email);
    await user.type(email, "owner@example.com");
    await user.click(screen.getByLabelText("Password", { exact: true }));

    // Helper + inline error now share one wording (copy unification):
    // both render, so two matches are correct; aria-invalid proves the error.
    expect(
      await screen.findAllByText("Only @gmail.com (or @googlemail.com) accounts are supported.")
    ).toHaveLength(2);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector('[data-slot="form-error-summary"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("failed submit: shows the error inline only, once, input preserved, no request", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@example.com", "some-password-1");

    // Helper + inline error share one wording now: 2 matches, still no summary box.
    expect(
      screen.getAllByText("Only @gmail.com (or @googlemail.com) accounts are supported.")
    ).toHaveLength(2);
    expect(document.querySelector('[data-slot="form-error-summary"]')).toBeNull();
    expect((screen.getByLabelText("Email Address") as HTMLInputElement).value).toBe(
      "owner@example.com"
    );
    expect((screen.getByLabelText("Password", { exact: true }) as HTMLInputElement).value).toBe(
      "some-password-1"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("empty submit shows both field errors inline only, once each", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.click(screen.getByRole("button", { name: "Sign In" }));

    // Inline only: no summary box duplicating the messages.
    expect(await screen.findAllByText("Please enter your password.")).toHaveLength(1);
    expect(screen.getAllByText("Please enter a valid Gmail address.")).toHaveLength(1);
    expect(document.querySelector('[data-slot="form-error-summary"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wrong password: the server message appears once as a plain inline line, no summary box", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "Invalid email or password" }));
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@gmail.com", "wrong-password");

    expect(await screen.findByText("Invalid email or password")).toBeTruthy();
    expect(screen.getAllByText("Invalid email or password")).toHaveLength(1);
    expect(document.querySelector('[data-slot="form-error-summary"]')).toBeNull();
    expect((screen.getByLabelText("Email Address") as HTMLInputElement).value).toBe("owner@gmail.com");
    expect((screen.getByLabelText("Password", { exact: true }) as HTMLInputElement).value).toBe(
      "wrong-password"
    );
    expect(completeAuthRedirect).not.toHaveBeenCalled();
  });

  it("server 400 field errors map back onto the fields inline only", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse(400, {
        error: "Validation failed",
        details: { email: ["This email address cannot be used."] },
      })
    );
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@gmail.com", "some-password-1");

    expect(await screen.findAllByText("This email address cannot be used.")).toHaveLength(1);
    expect(screen.getByLabelText("Email Address").getAttribute("aria-invalid")).toBe("true");
  });

  it("network failure surfaces the connection message as a plain inline line, never silently", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@gmail.com", "some-password-1");

    expect(
      await screen.findByText("Couldn't sign you in. Please check your connection and try again.")
    ).toBeTruthy();
    expect(document.querySelector('[data-slot="form-error-summary"]')).toBeNull();
  });

  it("successful sign-in posts the payload and hands the redirect to completeAuthRedirect", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(200, SUCCESS_BODY));
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@gmail.com", "correct-password");

    await waitFor(() =>
      expect(completeAuthRedirect).toHaveBeenCalledWith("/tenant/e2e", SUCCESS_BODY.user)
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      email: "owner@gmail.com",
      password: "correct-password",
    });
  });

  it("submit button shows the loading state and is disabled while the request is pending", async () => {
    const user = userEvent.setup();
    let release: (value: Response) => void = () => undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      })
    );
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@gmail.com", "correct-password");

    const button = screen.getByRole("button", { name: "Sign In" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    expect(button.getAttribute("aria-busy")).toBe("true");
    release(jsonResponse(200, SUCCESS_BODY));
    await waitFor(() => expect(completeAuthRedirect).toHaveBeenCalled());
  });

  it("password visibility toggle switches the field type", async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    const password = screen.getByLabelText("Password", { exact: true }) as HTMLInputElement;
    expect(password.type).toBe("password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password.type).toBe("text");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password.type).toBe("password");
  });
});

describe("login session-expired contract (§3.1)", () => {
  it("renders the session-expired notice when reason=session-expired is present", () => {
    setUrl("/login?next=%2Ftenant%2Fe2e%2Fpages&reason=session-expired");
    render(<LoginPage />);
    expect(screen.getByText(SESSION_EXPIRED_NOTICE)).toBeTruthy();
  });

  it("honours the safe `next` path as the post-login returnUrl", async () => {
    const user = userEvent.setup();
    setUrl("/login?next=%2Ftenant%2Fe2e%2Fpages&reason=session-expired");
    fetchMock.mockResolvedValue(jsonResponse(200, SUCCESS_BODY));
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@gmail.com", "correct-password");

    await waitFor(() => expect(completeAuthRedirect).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).returnUrl).toBe("/tenant/e2e/pages");
  });

  it("never honours an external `next` (no open redirect)", async () => {
    const user = userEvent.setup();
    setUrl("/login?next=https%3A%2F%2Fevil.example%2Fphish");
    fetchMock.mockResolvedValue(jsonResponse(200, SUCCESS_BODY));
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@gmail.com", "correct-password");

    await waitFor(() => expect(completeAuthRedirect).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { returnUrl?: string };
    expect(body.returnUrl ?? "").not.toContain("evil.example");
  });

  it("still honours the legacy returnUrl parameter", async () => {
    const user = userEvent.setup();
    setUrl("/login?returnUrl=%2Ftenant%2Fe2e%2Fmedia");
    fetchMock.mockResolvedValue(jsonResponse(200, SUCCESS_BODY));
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@gmail.com", "correct-password");

    await waitFor(() => expect(completeAuthRedirect).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).returnUrl).toBe("/tenant/e2e/media");
  });
});

describe("login returnUrl sent to the API (absolute-URL Validation failed fix)", () => {
  it("toApiReturnUrl strips an absolute workspace URL to its relative path", () => {
    expect(toApiReturnUrl("https://shahzebpyc.fbuploadpro.com/tenant/e2e/pages")).toBe(
      "/tenant/e2e/pages"
    );
    expect(
      toApiReturnUrl("https://shahzebpyc.fbuploadpro.com/tenant/e2e/pages?tab=media#top")
    ).toBe("/tenant/e2e/pages?tab=media#top");
    expect(toApiReturnUrl("https://shahzebpyc.fbuploadpro.com/")).toBe("/");
  });

  it("toApiReturnUrl passes an already-relative path through unchanged", () => {
    expect(toApiReturnUrl("/tenant/e2e/pages")).toBe("/tenant/e2e/pages");
    expect(toApiReturnUrl("/tenant/e2e/pages?tab=media")).toBe("/tenant/e2e/pages?tab=media");
  });

  it("toApiReturnUrl omits a relative result that does not start with '/'", () => {
    // Opaque absolute URLs (non-special scheme) parse to a bare path
    // segment, not an in-app path.
    expect(toApiReturnUrl("custom:evil.example/phish")).toBeUndefined();
    expect(toApiReturnUrl("custom:tenant")).toBeUndefined();
  });

  it("toApiReturnUrl omits /dashboard, protocol-relative, backslashed, and garbage values", () => {
    expect(toApiReturnUrl("/dashboard")).toBeUndefined();
    expect(toApiReturnUrl("/dashboard/settings")).toBeUndefined();
    expect(toApiReturnUrl("https://shahzebpyc.fbuploadpro.com/dashboard")).toBeUndefined();
    expect(toApiReturnUrl("//evil.example/phish")).toBeUndefined();
    expect(toApiReturnUrl("/tenant\\e2e")).toBeUndefined();
    expect(toApiReturnUrl("not-a-path")).toBeUndefined();
    expect(toApiReturnUrl("")).toBeUndefined();
    expect(toApiReturnUrl(undefined)).toBeUndefined();
  });

  it("an absolute workspace entry URL results in a RELATIVE returnUrl in the login request", async () => {
    const user = userEvent.setup();
    // Make the workspace host an allowed host for sanitizeAuthRedirectUrl,
    // as it is in production (NEXT_PUBLIC_ROOT_DOMAIN=fbuploadpro.com),
    // so the page state holds the absolute URL — the exact case that
    // used to reach the API and fail with bare "Validation failed".
    vi.stubEnv("NEXT_PUBLIC_ROOT_DOMAIN", "fbuploadpro.com");
    try {
      setUrl(
        "/login?returnUrl=https%3A%2F%2Fshahzebpyc.fbuploadpro.com%2Ftenant%2Fe2e%2Fpages"
      );
      fetchMock.mockResolvedValue(jsonResponse(200, SUCCESS_BODY));
      render(<LoginPage />);
      await fillAndSubmit(user, "owner@gmail.com", "correct-password");

      await waitFor(() => expect(completeAuthRedirect).toHaveBeenCalled());
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as { returnUrl?: string };
      expect(body.returnUrl).toBe("/tenant/e2e/pages");
      expect(body.returnUrl).not.toContain("://");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a /dashboard entry URL is omitted from the login request, never sent", async () => {
    const user = userEvent.setup();
    setUrl("/login?returnUrl=%2Fdashboard");
    fetchMock.mockResolvedValue(jsonResponse(200, SUCCESS_BODY));
    render(<LoginPage />);
    await fillAndSubmit(user, "owner@gmail.com", "correct-password");

    await waitFor(() => expect(completeAuthRedirect).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { returnUrl?: string };
    expect(body.returnUrl).toBeUndefined();
  });
});
