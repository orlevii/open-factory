import { MSG } from "@open-factory/shared";
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
  release(
    json({ error: { code: "credential_rejected", message: "Claude rejected this token." } }, 422),
  );
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
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/or" }),
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
  expect(describedText(within(dialog).getByLabelText("Path"))).toContain(MSG.hostPathStart);
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
  expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
    name: "app",
    hostPath: "/code/app",
  });
});

test("project: ~ paths post unexpanded; Path has the help line and the find-path button", async () => {
  const api = mockApi({
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/or" }),
    "POST /api/projects": () =>
      json({ project: { name: "web", hostPath: "~/code/web", grantedTo: [] } }, 201),
  });
  inSheet(
    "Add project",
    <AddProjectForm frame="sheet" existing={[]} onDone={vi.fn()} onCancel={vi.fn()} />,
  );
  const dialog = screen.getByRole("dialog", { name: "Add project" });
  const path = within(dialog).getByLabelText("Path");
  expect(describedText(path)).toContain("A folder on the factory's machine, like ~/code/web.");
  const find = within(dialog).getByRole("button", { name: "How do I find this path?" });
  expect(find.parentElement).toHaveTextContent("Path");
  await userEvent.type(within(dialog).getByLabelText("Name"), "web");
  await userEvent.type(path, "~/code/web{Enter}");
  await waitFor(() => expect(api.calls.some((c) => c.method === "POST")).toBe(true));
  expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
    name: "web",
    hostPath: "~/code/web",
  });
});

test("project: a relative path shows the start message on blur; a server hostPath error focuses Path", async () => {
  mockApi({
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/or" }),
    "POST /api/projects": () =>
      json(
        {
          error: {
            code: "validation_error",
            message: MSG.hostPathStart,
            fields: { hostPath: MSG.hostPathStart },
          },
        },
        400,
      ),
  });
  inSheet(
    "Add project",
    <AddProjectForm frame="sheet" existing={[]} onDone={vi.fn()} onCancel={vi.fn()} />,
  );
  const dialog = screen.getByRole("dialog", { name: "Add project" });
  const path = within(dialog).getByLabelText("Path");
  await userEvent.type(path, "code/web");
  await userEvent.tab();
  expect(describedText(path)).toContain("Start with / or ~/.");
  await userEvent.clear(path);
  await userEvent.type(within(dialog).getByLabelText("Name"), "web");
  await userEvent.type(path, "/code/web{Enter}");
  await waitFor(() => expect(path).toHaveAttribute("aria-invalid", "true"));
  expect(describedText(path)).toContain(MSG.hostPathStart);
  expect(path).toHaveFocus();
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
