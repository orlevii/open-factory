import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { json, mockApi } from "@/test/mock-api";
import { CompactPopover } from "./compact-popover";

const fail = () => json({ error: { code: "conflict", message: "Agent is busy." } }, 409);

test("a failed compact shows its message in an alert, announced again on a repeat", async () => {
  mockApi({ "POST /api/agents/dev/compact": fail });
  render(
    <TooltipProvider>
      <CompactPopover slug="dev" open onOpenChange={() => {}} />
    </TooltipProvider>,
  );
  const u = userEvent.setup();
  const dialog = await screen.findByRole("dialog");
  await u.click(within(dialog).getByRole("button", { name: "Compact" }));
  const first = await screen.findByText("Agent is busy.");
  const alert = first.closest('[role="alert"]');
  expect(alert).not.toBeNull();
  // Shared pieces: the outcome line sits above the button, and the field keeps its reserved note.
  expect(alert?.closest(".form-outcome")).not.toBeNull();
  expect(
    alert?.compareDocumentPosition(within(dialog).getByRole("button", { name: "Compact" })),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(dialog.querySelector(".field-note")).not.toBeNull();
  await u.click(within(dialog).getByRole("button", { name: "Compact" }));
  await vi.waitFor(() => expect(screen.getByText("Agent is busy.")).not.toBe(first));
});

test("an unreachable server shows the short unreachable line and keeps the typed focus", async () => {
  mockApi({
    "POST /api/agents/dev/compact": () => {
      throw new TypeError("Failed to fetch");
    },
  });
  render(
    <TooltipProvider>
      <CompactPopover slug="dev" open onOpenChange={() => {}} />
    </TooltipProvider>,
  );
  const u = userEvent.setup();
  const dialog = await screen.findByRole("dialog");
  await u.type(within(dialog).getByLabelText("Focus (optional)"), "auth module");
  await u.click(within(dialog).getByRole("button", { name: "Compact" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(FORM_MSG.unreachable);
  expect(within(dialog).getByLabelText("Focus (optional)")).toHaveValue("auth module");
  expect(within(dialog).getByRole("button", { name: "Compact" })).toBeEnabled();
});
