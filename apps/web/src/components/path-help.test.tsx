import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { PathHelp } from "@/components/path-help";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { InlineForm } from "@/features/settings/shared";
import { createQueryClient } from "@/lib/query-client";
import { json, mockApi } from "@/test/mock-api";

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ subscribe: () => () => {} }) }));

afterEach(() => vi.unstubAllGlobals());

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={createQueryClient()}>{ui}</QueryClientProvider>);
const host = (platform: string, hostname: string, home: string) => () =>
  json({ platform, hostname, home });
const trigger = () => screen.getByRole("button", { name: "How do I find this path?" });

test("darwin: names the machine and gives Finder steps", async () => {
  mockApi({ "GET /api/host": host("darwin", "mac", "/Users/or") });
  wrap(<PathHelp />);
  await userEvent.click(trigger());
  const dialog = await screen.findByRole("dialog", { name: "How to find a path" });
  await waitFor(() => expect(dialog).toHaveTextContent("Paths are on mac, the factory's machine."));
  expect(dialog).toHaveTextContent("~ means /Users/or.");
  expect(dialog).toHaveTextContent("In Finder, select the folder");
  expect(dialog).toHaveTextContent("Or run pwd in a terminal opened in the folder.");
  expect(dialog).not.toHaveTextContent("Ctrl");
  const keys = [...dialog.querySelectorAll("kbd")].map((k) => k.textContent);
  expect(keys).toEqual(expect.arrayContaining(["⌥", "⌘"]));
});

test("linux: terminal and file manager steps", async () => {
  mockApi({ "GET /api/host": host("linux", "box", "/home/or") });
  wrap(<PathHelp />);
  await userEvent.click(trigger());
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(dialog).toHaveTextContent("Paths are on box"));
  expect(dialog).toHaveTextContent("Run pwd in a terminal opened in the folder.");
  expect(dialog).toHaveTextContent("press CtrlL and copy");
  expect([...dialog.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl", "L"]);
  expect(dialog).not.toHaveTextContent("Finder");
});

test("fallback: both platforms, no error UI", async () => {
  const api = mockApi({});
  wrap(<PathHelp />);
  await userEvent.click(trigger());
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(api.calls.some((c) => c.url === "/api/host")).toBe(true));
  expect(dialog).toHaveTextContent("Paths are on the factory's machine.");
  expect(dialog).not.toHaveTextContent("~ means");
  expect(within(dialog).getByText("macOS")).toBeInTheDocument();
  expect(within(dialog).getByText("Linux")).toBeInTheDocument();
  expect(within(dialog).getAllByRole("list")).toHaveLength(2);
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(within(dialog).queryByRole("button")).toBeNull();
});

test("fetches the host only once opened", async () => {
  const api = mockApi({ "GET /api/host": host("linux", "box", "/home/or") });
  wrap(<PathHelp />);
  expect(api.calls.some((c) => c.url === "/api/host")).toBe(false);
  await userEvent.click(trigger());
  await waitFor(() => expect(api.calls.some((c) => c.url === "/api/host")).toBe(true));
});

test("keyboard: Enter opens and focuses content; Esc, Tab and Shift+Tab close to the trigger", async () => {
  mockApi({ "GET /api/host": host("linux", "box", "/home/or") });
  const user = userEvent.setup();
  wrap(<PathHelp />);
  trigger().focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(dialog).toHaveFocus());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(trigger()).toHaveFocus();

  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
  await user.keyboard("{Tab}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(trigger()).toHaveFocus();

  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getByRole("dialog")).toHaveFocus());
  await user.keyboard("{Shift>}{Tab}{/Shift}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(trigger()).toHaveFocus();
});

test.each(["{Escape}", "{Tab}"])("inside a Sheet: %s closes only the popover", async (key) => {
  mockApi({ "GET /api/host": host("linux", "box", "/home/or") });
  const user = userEvent.setup();
  wrap(
    <Sheet open onOpenChange={() => {}}>
      <SheetContent>
        <SheetTitle>S</SheetTitle>
        <PathHelp />
      </SheetContent>
    </Sheet>,
  );
  await user.click(trigger());
  await screen.findByRole("dialog", { name: "How to find a path" });
  await user.keyboard(key);
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "How to find a path" })).toBeNull(),
  );
  expect(screen.getByRole("dialog", { name: "S" })).toBeInTheDocument();
});

test.each(["{Escape}", "{Tab}"])(
  "inside an InlineForm: %s closes the popover, not the form",
  async (key) => {
    mockApi({ "GET /api/host": host("linux", "box", "/home/or") });
    const cancel = vi.fn();
    const user = userEvent.setup();
    wrap(
      <InlineForm
        label="F"
        onSubmit={() => {}}
        onCancel={cancel}
        submitLabel="Save"
        pendingLabel="Saving"
        pending={false}
        outcome={{ outcomeKey: 0 }}
      >
        <PathHelp />
      </InlineForm>,
    );
    await user.click(trigger());
    await screen.findByRole("dialog");
    await user.keyboard(key);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByRole("form", { name: "F" })).toBeInTheDocument();
  },
);

test("trigger is a non-submitting, validation-skipping button", () => {
  mockApi({});
  wrap(<PathHelp />);
  expect(trigger()).toHaveAttribute("data-skip-validate");
  expect(trigger()).toHaveAttribute("type", "button");
});
