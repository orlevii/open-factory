import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { AddCredentialForm } from "./add-credential-form";
import { AddProjectForm } from "./add-project-form";
import { AddSecretForm } from "./add-secret-form";

beforeEach(() => fakeMatchMedia.install(false));
afterEach(() => vi.unstubAllGlobals());

/** A stub Sheet around a form in its `sheet` frame. */
function inSheet(title: string, form: ReactNode) {
  return render(
    <Sheet open onOpenChange={() => {}}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        {form}
      </SheetContent>
    </Sheet>,
  );
}
const describedText = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();

test("credential: validates, submits once on Enter, maps a rejection under the token", async () => {
  let posts = 0;
  let release: (r: Response) => void = () => {};
  const api = mockApi({
    "POST /api/credentials": () => {
      posts++;
      return new Promise<Response>((r) => {
        release = r;
      });
    },
  });
  const onDone = vi.fn();
  const onCancel = vi.fn();
  inSheet(
    "Add credential",
    <AddCredentialForm frame="sheet" existing={["taken"]} onDone={onDone} onCancel={onCancel} />,
  );
  const dialog = screen.getByRole("dialog", { name: "Add credential" });
  // The sheet header has its own Close; the form's is the footer one.
  const close = within(dialog).getAllByRole("button", { name: "Close" }).at(-1) as HTMLElement;
  expect(close).toHaveAttribute("type", "button");
  await userEvent.type(within(dialog).getByLabelText("Name"), "taken{Enter}");
  expect(describedText(within(dialog).getByLabelText("Name"))).toBe("That name is taken.");
  expect(api.calls).toHaveLength(0);
  const name = within(dialog).getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "work");
  const token = within(dialog).getByLabelText("Token");
  await userEvent.type(token, "sk-bad{Enter}");
  await userEvent.type(token, "{Enter}");
  expect(await within(dialog).findByRole("button", { name: /Verifying…/ })).toBeInTheDocument();
  expect(posts).toBe(1);
  release(err("credential_rejected", "Claude rejected this token."));
  await waitFor(() => expect(token).toHaveAttribute("aria-invalid", "true"));
  expect(describedText(token)).toBe("Claude rejected this token.");
  expect(token).toHaveFocus();
  expect(onDone).not.toHaveBeenCalled();
  await userEvent.click(close);
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("secret: uppercases, validates, submits once on Enter, maps a reserved name under Name", async () => {
  let puts = 0;
  let release: (r: Response) => void = () => {};
  const api = mockApi({
    "PUT /api/secrets/MY_VAR": () => {
      puts++;
      return new Promise<Response>((r) => {
        release = r;
      });
    },
  });
  inSheet(
    "Add secret",
    <AddSecretForm
      frame="sheet"
      initialName=""
      existing={[]}
      onDone={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Add secret" });
  await userEvent.type(within(dialog).getByLabelText("Name"), "my_var{Enter}");
  expect(within(dialog).getByLabelText("Name")).toHaveValue("MY_VAR");
  expect(describedText(within(dialog).getByLabelText("Value"))).toBe("Enter a value.");
  expect(api.calls).toHaveLength(0);
  await userEvent.type(within(dialog).getByLabelText("Value"), "v{Enter}");
  await userEvent.type(within(dialog).getByLabelText("Value"), "{Enter}");
  expect(await within(dialog).findByRole("button", { name: /Adding…/ })).toBeInTheDocument();
  expect(puts).toBe(1);
  release(
    json({ error: { code: "secret_name_reserved", message: "That name is reserved." } }, 409),
  );
  const name = within(dialog).getByLabelText("Name");
  await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
  expect(describedText(name)).toBe("That name is reserved.");
  expect(name).toHaveFocus();
  expect(puts).toBe(1);
});

test("secret: a prefilled name focuses Value in the sheet frame", async () => {
  inSheet(
    "Add secret",
    <AddSecretForm
      frame="sheet"
      initialName="GH_TOKEN"
      existing={[]}
      onDone={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Add secret" });
  expect(within(dialog).getByLabelText("Name")).toHaveValue("GH_TOKEN");
  await waitFor(() => expect(within(dialog).getByLabelText("Value")).toHaveFocus());
});

test("project: validates, submits once on Enter, maps a duplicate under Name", async () => {
  let posts = 0;
  let release: (r: Response) => void = () => {};
  const api = mockApi({
    "POST /api/projects": () => {
      posts++;
      return new Promise<Response>((r) => {
        release = r;
      });
    },
  });
  inSheet(
    "Add project",
    <AddProjectForm frame="sheet" existing={[]} onDone={vi.fn()} onCancel={vi.fn()} />,
  );
  const dialog = screen.getByRole("dialog", { name: "Add project" });
  await userEvent.type(within(dialog).getByLabelText("Name"), "app");
  await userEvent.type(within(dialog).getByLabelText("Path"), "rel{Enter}");
  expect(describedText(within(dialog).getByLabelText("Path"))).toContain("Enter an absolute path.");
  expect(api.calls).toHaveLength(0);
  const path = within(dialog).getByLabelText("Path");
  await userEvent.clear(path);
  await userEvent.type(path, "/code/app{Enter}");
  await userEvent.type(path, "{Enter}");
  expect(await within(dialog).findByRole("button", { name: /Adding…/ })).toBeInTheDocument();
  expect(posts).toBe(1);
  release(json({ error: { code: "project_exists", message: "A project named app exists." } }, 409));
  const name = within(dialog).getByLabelText("Name");
  await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
  expect(describedText(name)).toBe("A project named app exists.");
  expect(posts).toBe(1);
  expect(api.calls[0]?.body).toEqual({ name: "app", hostPath: "/code/app" });
});

test("secret: the inline frame shows a form-level error through the outcome line, above the buttons", async () => {
  mockApi({
    "PUT /api/secrets/MY_VAR": () =>
      json({ error: { code: "boom", message: "The store is unavailable." } }, 500),
  });
  render(
    <AddSecretForm
      frame="inline"
      initialName=""
      existing={[]}
      onDone={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const form = screen.getByRole("form", { name: "Add secret" });
  await userEvent.type(within(form).getByLabelText("Name"), "my_var");
  await userEvent.type(within(form).getByLabelText("Value"), "v{Enter}");
  const text = await within(form).findByText("The store is unavailable.");
  expect(text.closest("[role=alert]")).toBeTruthy();
  const submit = within(form).getByRole("button", { name: "Add secret" });
  const line = text.closest(".form-outcome") as HTMLElement;
  expect(line.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("ref reaches the <form> in the sheet and inline frames, AuthCard and InlineForm", async () => {
  const { createRef } = await import("react");
  const { FormFrame } = await import("./form-frame");
  const { InlineForm } = await import("@/features/settings/shared");
  const { AuthCard } = await import("@/components/auth-card");
  const { NO_OUTCOME } = await import("@/components/forms/form-outcome");
  const common = {
    label: "Thing",
    onSubmit() {},
    onCancel() {},
    submitLabel: "Save",
    pendingLabel: "Saving…",
    pending: false,
    outcome: NO_OUTCOME,
  };
  for (const frame of ["sheet", "inline"] as const) {
    const ref = createRef<HTMLFormElement>();
    const { unmount } = render(
      <FormFrame frame={frame} ref={ref} {...common}>
        <input aria-label="x" />
      </FormFrame>,
    );
    expect(ref.current).toBeInstanceOf(HTMLFormElement);
    expect(ref.current).toBe(screen.getByRole("form", { name: "Thing" }));
    unmount();
  }
  const inline = createRef<HTMLFormElement>();
  const a = render(
    <InlineForm ref={inline} {...common}>
      <input aria-label="x" />
    </InlineForm>,
  );
  expect(inline.current).toBe(screen.getByRole("form", { name: "Thing" }));
  a.unmount();
  const auth = createRef<HTMLFormElement>();
  render(
    <AuthCard
      ref={auth}
      title="Sign in"
      submitLabel="Go"
      pendingLabel="Going"
      submitting={false}
      outcome={NO_OUTCOME}
      onSubmit={() => {}}
      footer={null}
    >
      <input aria-label="x" />
    </AuthCard>,
  );
  expect(auth.current).toBeInstanceOf(HTMLFormElement);
  expect(auth.current?.contains(screen.getByLabelText("x"))).toBe(true);
});

const err = (code: string, message: string, extra: object = {}) =>
  json({ error: { code, message, ...extra } }, 422);

test("every add form: empty submit focuses the first field, and an untouched blur stays clean", async () => {
  const forms: [string, ReactNode][] = [
    [
      "Add credential",
      <AddCredentialForm key="c" frame="sheet" existing={[]} onDone={vi.fn()} onCancel={vi.fn()} />,
    ],
    [
      "Add project",
      <AddProjectForm key="p" frame="sheet" existing={[]} onDone={vi.fn()} onCancel={vi.fn()} />,
    ],
    [
      "Add secret",
      <AddSecretForm
        key="s"
        frame="sheet"
        initialName=""
        existing={[]}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    ],
  ];
  for (const [title, form] of forms) {
    const { unmount } = inSheet(title, form);
    const dialog = screen.getByRole("dialog", { name: title });
    const first = within(dialog).getByLabelText("Name");
    await userEvent.click(first);
    await userEvent.tab();
    expect(first).not.toHaveAttribute("aria-invalid");
    await userEvent.click(within(dialog).getByRole("button", { name: /^(Verify and add|Add )/ }));
    await waitFor(() => expect(first).toHaveFocus());
    expect(first).toHaveAttribute("aria-invalid", "true");
    unmount();
  }
});

test("project: a server fields.hostPath lands under Path and focuses it", async () => {
  mockApi({
    "POST /api/projects": () =>
      json(
        { error: { code: "validation_error", message: "Bad", fields: { hostPath: "Not here." } } },
        400,
      ),
  });
  inSheet(
    "Add project",
    <AddProjectForm frame="sheet" existing={[]} onDone={vi.fn()} onCancel={vi.fn()} />,
  );
  const dialog = screen.getByRole("dialog", { name: "Add project" });
  await userEvent.type(within(dialog).getByLabelText("Name"), "app");
  await userEvent.type(within(dialog).getByLabelText("Path"), "/code/app{Enter}");
  const path = within(dialog).getByLabelText("Path");
  await waitFor(() => expect(path).toHaveFocus());
  expect(describedText(path)).toContain("Not here.");
});

test("secret and credential: a server fields.* lands under its field and focuses it", async () => {
  mockApi({
    "PUT /api/secrets/MY_VAR": () =>
      json(
        { error: { code: "validation_error", message: "Bad", fields: { value: "Too big." } } },
        400,
      ),
    "POST /api/credentials": () =>
      json({ error: { code: "validation_error", message: "Bad", fields: { name: "Nope." } } }, 400),
  });
  const s = inSheet(
    "Add secret",
    <AddSecretForm
      frame="sheet"
      initialName=""
      existing={[]}
      onDone={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  let dialog = screen.getByRole("dialog", { name: "Add secret" });
  await userEvent.type(within(dialog).getByLabelText("Name"), "my_var");
  await userEvent.type(within(dialog).getByLabelText("Value"), "v{Enter}");
  await waitFor(() => expect(within(dialog).getByLabelText("Value")).toHaveFocus());
  expect(describedText(within(dialog).getByLabelText("Value"))).toBe("Too big.");
  s.unmount();
  inSheet(
    "Add credential",
    <AddCredentialForm frame="sheet" existing={[]} onDone={vi.fn()} onCancel={vi.fn()} />,
  );
  dialog = screen.getByRole("dialog", { name: "Add credential" });
  await userEvent.type(within(dialog).getByLabelText("Name"), "work");
  await userEvent.type(within(dialog).getByLabelText("Token"), "t{Enter}");
  await waitFor(() => expect(within(dialog).getByLabelText("Name")).toHaveFocus());
  expect(describedText(within(dialog).getByLabelText("Name"))).toBe("Nope.");
});

test("credential: unverifiable is a warning in the token note plus a form line; editing clears it; OAuth help shows", async () => {
  mockApi({
    "POST /api/credentials": () =>
      err("credential_unverifiable", "Couldn't reach Claude to check."),
  });
  inSheet(
    "Add credential",
    <AddCredentialForm frame="sheet" existing={[]} onDone={vi.fn()} onCancel={vi.fn()} />,
  );
  const dialog = screen.getByRole("dialog", { name: "Add credential" });
  const token = within(dialog).getByLabelText("Token");
  expect(describedText(token)).toBe("Create one with claude setup-token.");
  await userEvent.type(within(dialog).getByLabelText("Name"), "work");
  await userEvent.type(token, "t{Enter}");
  const alert = await within(dialog).findByText("Couldn't add the credential.");
  expect(alert.closest("[role=alert]")).toBeTruthy();
  expect(describedText(token)).toBe("Couldn't reach Claude to check.");
  expect(token).not.toHaveAttribute("aria-invalid");
  await userEvent.type(token, "x");
  expect(describedText(token)).toBe("Create one with claude setup-token.");
});
