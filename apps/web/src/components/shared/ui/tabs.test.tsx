import * as React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";

function TestTabs({ withDisabled = false }: { withDisabled?: boolean }) {
  return (
    <Tabs defaultValue="queue">
      <TabsList aria-label="Sections">
        <TabsTrigger value="queue">Queue</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
        <TabsTrigger value="settings" disabled={withDisabled}>
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value="queue">Queue panel</TabsContent>
      <TabsContent value="history">History panel</TabsContent>
      <TabsContent value="settings">Settings panel</TabsContent>
    </Tabs>
  );
}

describe("Tabs (ARIA tabs pattern)", () => {
  it("renders the selected tab and its panel; unselected panels are absent", () => {
    render(<TestTabs />);
    const queue = screen.getByRole("tab", { name: "Queue" });
    expect(queue).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Queue panel");
  });

  it("spec 142 F07: list is viewport-bounded and scrollable; triggers are 36px", () => {
    render(<TestTabs />);
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("max-w-full");
    expect(list.className).toContain("overflow-x-auto");
    expect(screen.getByRole("tab", { name: "Queue" }).className).toContain("h-9");
    expect(screen.getByRole("tab", { name: "History" }).className).toContain("h-9");
    // Triggers must never shrink (the list scrolls instead): shrink-0 has to
    // survive tailwind-merge in the rendered class list — it is dropped when
    // paired with flex-1, which is why the trigger uses grow + basis-0.
    expect(screen.getByRole("tab", { name: "Queue" }).className).toContain("shrink-0");
    expect(screen.getByRole("tab", { name: "Queue" }).className).not.toContain("flex-1");
  });

  it("arrow keys move selection and focus (automatic activation)", async () => {
    const user = userEvent.setup();
    render(<TestTabs />);
    const queue = screen.getByRole("tab", { name: "Queue" });
    const history = screen.getByRole("tab", { name: "History" });
    queue.focus();
    await user.keyboard("{ArrowRight}");
    expect(history).toHaveAttribute("aria-selected", "true");
    expect(history).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("History panel");
    await user.keyboard("{ArrowLeft}");
    expect(queue).toHaveAttribute("aria-selected", "true");
    expect(queue).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Queue panel");
  });

  it("Home / End jump to the first / last tab", async () => {
    const user = userEvent.setup();
    render(<TestTabs />);
    screen.getByRole("tab", { name: "Queue" }).focus();
    await user.keyboard("{End}");
    const settings = screen.getByRole("tab", { name: "Settings" });
    expect(settings).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Settings panel");
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Queue" })).toHaveAttribute("aria-selected", "true");
  });

  it("clicking a tab selects it", async () => {
    const user = userEvent.setup();
    render(<TestTabs />);
    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("History panel");
  });

  it("line trigger variant: active tab is bold with a 4px ink underline at content width, no panel background", () => {
    render(
      <Tabs defaultValue="queue">
        <TabsList variant="line" aria-label="Sections">
          <TabsTrigger value="queue" variant="line">
            Queue
          </TabsTrigger>
          <TabsTrigger value="history" variant="line">
            History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="queue">Queue panel</TabsContent>
        <TabsContent value="history">History panel</TabsContent>
      </Tabs>
    );
    const active = screen.getByRole("tab", { name: "Queue" });
    // Thicker fixed-width bar, inset by the trigger padding so it
    // spans the label's content width, not the full trigger width.
    expect(active.className).toContain("after:h-1");
    expect(active.className).toContain("after:left-3");
    expect(active.className).toContain("after:right-3");
    expect(active.className).toContain("data-[state=active]:after:bg-ink");
    expect(active.className).toContain("data-[state=active]:font-bold");
    expect(active.className).not.toContain("data-[state=active]:bg-panel");
    expect(active.className).not.toContain("data-[state=active]:shadow-card");
    // Inactive tab stays muted, with no underline of its own.
    expect(screen.getByRole("tab", { name: "History" }).className).toContain("text-ink-sub");
  });

  it("a disabled tab cannot be selected by click or arrow keys", async () => {
    const user = userEvent.setup();
    render(<TestTabs withDisabled />);
    const settings = screen.getByRole("tab", { name: "Settings" });
    expect(settings).toBeDisabled();
    await user.click(settings);
    expect(settings).toHaveAttribute("aria-selected", "false");
    screen.getByRole("tab", { name: "History" }).focus();
    await user.keyboard("{ArrowRight}");
    // Arrow past the disabled tab never lands the selection on it.
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel")).not.toHaveTextContent("Settings panel");
  });
});
