/** @vitest-environment jsdom */
/**
 * PasswordInput — behavioural tests for the rebuilt shared auth password
 * control (spec 136 §5.7 / T12): shared/ui Input + show/hide toggle +
 * Caps Lock warning, in both its form-standard usage (input props only,
 * ARIA wired by the caller) and its standalone usage (label / helper /
 * error rendered by the control).
 */
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordInput } from "./password-input";

describe("PasswordInput (shared auth password control)", () => {
  it("renders masked by default and toggles visibility", async () => {
    const user = userEvent.setup();
    render(<PasswordInput label="Test Password" placeholder="Enter password" />);
    const input = screen.getByLabelText("Test Password") as HTMLInputElement;
    expect(input.type).toBe("password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(input.type).toBe("text");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(input.type).toBe("password");
  });

  it("standalone mode renders helper text and the inline error with aria-invalid", () => {
    render(
      <PasswordInput
        label="Confirm Password"
        helperText="Minimum 8 characters"
        error="Passwords do not match. Enter the same password in both fields."
      />
    );
    expect(screen.getByText("Minimum 8 characters")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Passwords do not match. Enter the same password in both fields.");
    expect(screen.getByLabelText("Confirm Password").getAttribute("aria-invalid")).toBe("true");
  });

  it("warns while Caps Lock is on and clears the warning on blur", () => {
    render(<PasswordInput label="Password" />);
    const input = screen.getByLabelText("Password");
    const capsEvent = new KeyboardEvent("keydown", { key: "a", bubbles: true });
    Object.defineProperty(capsEvent, "getModifierState", {
      value: (key: string) => key === "CapsLock",
    });
    fireEvent(input, capsEvent);
    expect(screen.getByText("Caps Lock is on")).toBeTruthy();
    fireEvent.blur(input);
    expect(screen.queryByText("Caps Lock is on")).toBeNull();
  });

  it("forwards value and change events untouched (paste is never blocked)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PasswordInput aria-label="Password" onChange={onChange} />);
    const input = screen.getByLabelText("Password") as HTMLInputElement;
    await user.click(input);
    await user.paste("pasted-password-1");
    expect(onChange).toHaveBeenCalled();
    expect(input.value).toBe("pasted-password-1");
  });
});
