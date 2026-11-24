import { MSG } from "@open-factory/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { clearDraft } from "@/features/sheets/drafts";
import { FORM_MSG } from "@/lib/form-messages.ts";
import { createQueryClient } from "@/lib/query-client";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { NewTemplateForm } from "./new-template-form";

beforeEach(() => {
  fakeMatchMedia.install(false);
  clearDraft("new-template");
});
afterEach(() => vi.unstubAllGlobals());

const list =
  (...names: string[]) =>
  () =>
    json({
      dir: "/d",
      templates: names.map((name) => ({
        name,
        errors: 0,
        warnings: 0,
        agentCount: 0,
        pluginCount: 0,
      })),
    });
const created = (name: string) => () =>
  json(
    {
      template: {
        name,
        path: `/d/${name}`,
        files: [],
        issues: [],
        agents: [],
        avatar: { version: null, tooLarge: false },
      },
    },
    201,
  );

function mount(then: "open-editor" | "return" = "open-editor", extra = {}) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <Sheet open onOpenChange={() => {}}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New template</SheetTitle>
          </SheetHeader>
          <NewTemplateForm
            frame="sheet"
            then={then}
            onDone={onDone}
            onCancel={onCancel}
            {...extra}
          />
        </SheetContent>
      </Sheet>
    </QueryClientProvider>,
  );
  return { onDone, onCancel, unmount: view.unmount };
}
const dialog = () => screen.findByRole("dialog", { name: "New template" });

test("fields: Display name, the folder line, Description; the name follows the display name", async () => {
  mockApi({ "GET /api/templates": list() });
  mount();
  const d = await dialog();
  const labels = within(d)
    .getAllByRole("textbox")
    .map((e) => e.getAttribute("id"));
  // Prefixed: stacked over New agent, that form's Display name and Description are on the page too.
  expect(labels).toEqual(["field-template-displayName", "field-template-description"]);
  expect(within(d).queryByLabelText("Name")).toBeNull();
  await userEvent.type(within(d).getByLabelText("Display name"), "Priya Nair");
  expect(within(d).getByText("templates/priya-nair")).toBeInTheDocument();
  expect(within(d).getByRole("button", { name: "Change" })).toBeInTheDocument();
});

test("a taken folder gets -2", async () => {
  mockApi({ "GET /api/templates": list("priya-nair") });
  mount();
  const d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Priya Nair");
  await waitFor(() => expect(within(d).getByText("templates/priya-nair-2")).toBeInTheDocument());
});

test("Change reveals Name with its help, holding the derived folder name", async () => {
  mockApi({ "GET /api/templates": list() });
  mount();
  const d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Priya Nair");
  await userEvent.click(within(d).getByRole("button", { name: "Change" }));
  const name = within(d).getByLabelText("Name");
  expect(name).toHaveValue("priya-nair");
  expect(name).toHaveAccessibleDescription(
    "Lowercase letters, numbers and hyphens. Also the folder name.",
  );
});

test("submit sends the derived name once and reports it", async () => {
  let posts = 0;
  const api = mockApi({
    "GET /api/templates": list(),
    "POST /api/templates": () => {
      posts++;
      return created("priya-nair")();
    },
  });
  const { onDone } = mount();
  const d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Priya Nair");
  await userEvent.type(within(d).getByLabelText("Description (optional)"), "Reviews");
  await userEvent.type(within(d).getByLabelText("Display name"), "{Enter}");
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("priya-nair", expect.anything()));
  expect(posts).toBe(1);
  expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
    name: "priya-nair",
    displayName: "Priya Nair",
    description: "Reviews",
  });
});

test("a missing display name is an error on submit and sends nothing, Name stays folded", async () => {
  const api = mockApi({ "GET /api/templates": list() });
  mount();
  const d = await dialog();
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  expect(await within(d).findByText("Enter a display name.")).toBeInTheDocument();
  expect(within(d).queryByLabelText("Name")).toBeNull();
  expect(within(d).getByLabelText("Display name")).toHaveFocus();
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
});

test("server template_exists opens Name with the error", async () => {
  mockApi({
    "GET /api/templates": list(),
    "POST /api/templates": () =>
      json(
        { error: { code: "template_exists", message: "A template named lead already exists." } },
        409,
      ),
  });
  const { onDone } = mount();
  const d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Lead");
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  const name = await within(d).findByLabelText("Name");
  // The server's message names the value; the note uses the short constant (spec §8).
  expect(name).toHaveAccessibleDescription(FORM_MSG.nameTaken);
  expect(name).toHaveFocus();
  expect(onDone).not.toHaveBeenCalled();
});

test("a hand-typed reserved name is refused with the reserved message, nothing sent", async () => {
  const api = mockApi({ "GET /api/templates": list() });
  mount();
  const d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Images");
  expect(within(d).getByText("templates/images-2")).toBeInTheDocument();
  await userEvent.click(within(d).getByRole("button", { name: "Change" }));
  const name = within(d).getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "images");
  await userEvent.tab();
  // On blur, before any submit.
  expect(await within(d).findByText("That name is reserved.")).toBeInTheDocument();
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  expect(api.calls.some((c) => c.method === "POST")).toBe(false);
});

test("blur validates a typed name, not while typing", async () => {
  mockApi({ "GET /api/templates": list() });
  mount();
  const d = await dialog();
  await userEvent.click(within(d).getByRole("button", { name: "Change" }));
  const name = within(d).getByLabelText("Name");
  await userEvent.type(name, "Bad Name");
  expect(within(d).queryByText(MSG.startLetter)).not.toBeInTheDocument();
  await userEvent.tab();
  expect(await within(d).findByText(MSG.startLetter)).toBeInTheDocument();
});

test("a late failure goes to onLateError instead of the form", async () => {
  mockApi({
    "GET /api/templates": list(),
    "POST /api/templates": () => json({ error: { code: "boom", message: "Disk full." } }, 500),
  });
  const onLateError = vi.fn();
  mount("open-editor", { stillOpen: () => false, onLateError });
  const d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Lead");
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  await waitFor(() => expect(onLateError).toHaveBeenCalledWith("Disk full."));
});

test("a draft is kept for the editor sheet and announced with Discard, never for the stacked one", async () => {
  mockApi({ "GET /api/templates": list() });
  const first = mount("open-editor");
  let d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Draft me");
  first.unmount();
  const second = mount("open-editor");
  d = await dialog();
  expect(within(d).getByLabelText("Display name")).toHaveValue("Draft me");
  expect(within(d).getByText(/Draft restored/)).toBeInTheDocument();
  await userEvent.click(within(d).getByRole("button", { name: "Discard" }));
  expect(within(d).getByLabelText("Display name")).toHaveValue("");
  await userEvent.type(within(d).getByLabelText("Display name"), "Again");
  second.unmount();
  mount("return");
  d = await dialog();
  expect(within(d).getByLabelText("Display name")).toHaveValue("");
  expect(within(d).queryByText(/Draft restored/)).toBeNull();
});

test("a display name with no usable letters opens Name with the length rule", async () => {
  mockApi({ "GET /api/templates": list() });
  mount();
  const d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "!!!");
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  const name = await within(d).findByLabelText("Name");
  expect(name).toHaveAccessibleDescription(MSG.nameLength);
  expect(name).toHaveFocus();
});

test("an error that reveals Name keeps the revealed name in the draft", async () => {
  mockApi({
    "GET /api/templates": list(),
    "POST /api/templates": () =>
      json({ error: { code: "template_exists", message: "Taken." } }, 409),
  });
  const first = mount();
  let d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Lead");
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  await within(d).findByLabelText("Name");
  first.unmount();
  mount();
  d = await dialog();
  expect(within(d).getByLabelText("Name")).toHaveValue("lead");
});

test("a blur on untouched fields stays clean", async () => {
  mockApi({ "GET /api/templates": list() });
  mount();
  const d = await dialog();
  const display = within(d).getByLabelText("Display name");
  await userEvent.click(display);
  await userEvent.click(within(d).getByLabelText("Description (optional)"));
  await userEvent.click(display);
  expect(display).not.toHaveAttribute("aria-invalid");
  expect(within(d).getByLabelText("Description (optional)")).not.toHaveAttribute("aria-invalid");
  expect(within(d).queryByText("Enter a display name.")).toBeNull();
});

test("a changed display name that is emptied shows its error on blur", async () => {
  mockApi({ "GET /api/templates": list() });
  mount();
  const d = await dialog();
  const display = within(d).getByLabelText("Display name");
  await userEvent.type(display, "a");
  await userEvent.clear(display);
  await userEvent.click(within(d).getByLabelText("Description (optional)"));
  expect(await within(d).findByText("Enter a display name.")).toBeInTheDocument();
});

test("a server failure shows in the footer alert", async () => {
  mockApi({
    "GET /api/templates": list(),
    "POST /api/templates": () => json({ error: { code: "boom", message: "Disk full." } }, 500),
  });
  mount();
  const d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Lead");
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  const alert = (await within(d).findByText("Disk full.")).closest("[role=alert]");
  expect(alert).not.toBeNull();
  expect(within(d).getByRole("button", { name: "Create template" })).toBeEnabled();
});

test("a name error from the server reveals Name once, with the value kept", async () => {
  mockApi({
    "GET /api/templates": list(),
    "POST /api/templates": () =>
      json(
        {
          error: {
            code: "validation_error",
            message: "Invalid.",
            fields: { name: "That name is taken." },
          },
        },
        400,
      ),
  });
  mount();
  const d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Lead");
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  const name = await within(d).findByLabelText("Name");
  expect(name).toHaveValue("lead");
  expect(name).toHaveAccessibleDescription("That name is taken.");
  expect(name).toHaveFocus();
});

test.each([
  ["Bad", MSG.startLetter],
  ["a", MSG.nameLength],
  ["ab_c", MSG.nameChars],
  ["abc-", MSG.noTrailingHyphen],
])("a typed name %s shows one rule: %s", async (typed, message) => {
  mockApi({ "GET /api/templates": list() });
  mount();
  const d = await dialog();
  await userEvent.click(within(d).getByRole("button", { name: "Change" }));
  const name = within(d).getByLabelText("Name");
  await userEvent.type(name, typed);
  await userEvent.tab();
  expect(name).toHaveAccessibleDescription(message);
});

test("Discard clears a failure line along with the draft", async () => {
  mockApi({
    "GET /api/templates": list(),
    "POST /api/templates": () => json({ error: { code: "boom", message: "Disk full." } }, 500),
  });
  const first = mount();
  let d = await dialog();
  await userEvent.type(within(d).getByLabelText("Display name"), "Lead");
  first.unmount();
  mount();
  d = await dialog();
  await userEvent.click(within(d).getByRole("button", { name: "Create template" }));
  expect(await within(d).findByText("Disk full.")).toBeInTheDocument();
  await userEvent.click(within(d).getByRole("button", { name: "Discard" }));
  expect(within(d).queryByText("Disk full.")).toBeNull();
});

test.each(["Discard", "Change"])(
  "pressing %s doesn't count as leaving a changed, emptied Display name",
  async (button) => {
    mockApi({ "GET /api/templates": list() });
    const first = mount();
    let d = await dialog();
    await userEvent.type(within(d).getByLabelText("Display name"), "x");
    first.unmount();
    mount();
    d = await dialog();
    const display = within(d).getByLabelText("Display name");
    await userEvent.type(display, "y");
    await userEvent.clear(display);
    await userEvent.click(within(d).getByRole("button", { name: button }));
    expect(display).not.toHaveAttribute("aria-invalid");
    expect(within(d).queryByText(FORM_MSG.enterDisplayName)).toBeNull();
  },
);
