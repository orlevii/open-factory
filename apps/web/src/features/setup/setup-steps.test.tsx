import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { getSheetState, resetSheets } from "@/features/sheets/sheet-store";
import { json, mockApi } from "@/test/mock-api";
import { SetupSteps } from "./setup-steps";

afterEach(() => {
  act(() => resetSheets());
  vi.unstubAllGlobals();
});

// biome-ignore lint/suspicious/noThenProperty: SheetSpec's field, not a thenable
const NEW_TEMPLATE = { kind: "new-template", then: "open-editor" };
const status = { hasCredential: false, hasTemplate: false, hasAgent: false };
function show(s = status) {
  mockApi({ "GET /api/credentials": () => json({ credentials: [] }) });
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <SetupSteps status={s} />
    </QueryClientProvider>,
  );
}

test("three steps in order, each with its copy", () => {
  show();
  const section = screen.getByRole("region", { name: "Set up your factory" });
  expect(within(section).getByRole("heading", { level: 2 })).toHaveTextContent(
    "Set up your factory",
  );
  const rows = within(section).getAllByRole("button");
  expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
    "Step 1 of 3, Sign in to Claude, not done",
    "Step 2 of 3, Create a template, not done",
    "Step 3 of 3, Create an agent, not done",
  ]);
  expect(rows[0]).toHaveAccessibleDescription("Connect the Claude account your agents run on.");
  expect(rows[1]).toHaveAccessibleDescription(
    "A template is a role: persona, skills, tools and model.",
  );
  expect(rows[2]).toHaveAccessibleDescription(
    'It runs a template in its own session. Give it "Can manage the org" to have it build the rest.',
  );
});

test("a done step says so, and stays clickable", async () => {
  show({ hasCredential: true, hasTemplate: false, hasAgent: false });
  const one = screen.getByRole("button", { name: "Step 1 of 3, Sign in to Claude, done" });
  expect(one).toBeEnabled();
  expect(screen.getByRole("button", { name: /Step 2 of 3, .*, not done/ })).toBeEnabled();
  await userEvent.click(one);
  expect(getSheetState().parent).toMatchObject({ kind: "add-credential" });
});

test("step 3 is never done, even with everything else in place", () => {
  show({ hasCredential: true, hasTemplate: true, hasAgent: false });
  expect(
    screen.getByRole("button", { name: "Step 3 of 3, Create an agent, not done" }),
  ).toBeVisible();
});

test("each step opens its sheet", async () => {
  show();
  await userEvent.click(screen.getByRole("button", { name: /Step 2 of 3/ }));
  expect(getSheetState().parent).toMatchObject(NEW_TEMPLATE);
  act(() => resetSheets());
  await userEvent.click(screen.getByRole("button", { name: /Step 3 of 3/ }));
  expect(getSheetState().parent).toMatchObject({ kind: "new-agent" });
});
