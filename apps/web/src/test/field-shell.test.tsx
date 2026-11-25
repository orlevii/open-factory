import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";
import { TokenField } from "@/features/settings/forms/shared";

const input = (a: { id: string; describedBy?: string; invalid: boolean }) => (
  <input id={a.id} aria-describedby={a.describedBy} aria-invalid={a.invalid || undefined} />
);

test("FieldShell wires label, help and error; error replaces help", () => {
  const { rerender } = render(
    <FieldShell name="slug" label="Slug" help="How others address it.">
      {input}
    </FieldShell>,
  );
  expect(screen.getByLabelText("Slug")).toHaveAccessibleDescription("How others address it.");
  rerender(
    <FieldShell name="slug" label="Slug" help="How others address it." error="That slug is taken.">
      {input}
    </FieldShell>,
  );
  expect(screen.getByLabelText("Slug")).toHaveAccessibleDescription("That slug is taken.");
  expect(screen.getByLabelText("Slug")).toBeInvalid();
});

test("FieldShell legend renders a fieldset", () => {
  render(
    <FieldShell name="projects" label="Projects" legend>
      {() => <span>body</span>}
    </FieldShell>,
  );
  expect(screen.getByRole("group", { name: "Projects" })).toBeInTheDocument();
});

test("FieldShell legend is invalid with an error, and its label may carry a marker", () => {
  render(
    <FieldShell
      name="projects"
      label={
        <>
          Projects <span id="m">Custom</span>
        </>
      }
      legend
      describedBy="m"
      error="Project docs isn't registered."
    >
      {() => <input aria-label="x" />}
    </FieldShell>,
  );
  const group = screen.getByRole("group", { name: "Projects Custom" });
  expect(group).toHaveAttribute("aria-invalid", "true");
  expect(group).toHaveAttribute("aria-describedby", "field-projects-error m");
});

test("FormField keeps its API (S1 tests stay green)", () => {
  render(<FormField name="email" label="Email" error="Wrong" />);
  expect(screen.getByLabelText("Email")).toHaveAccessibleDescription("Wrong");
});

test("PasswordInput toggles visibility and opts out of managers", async () => {
  render(
    <>
      <label htmlFor="tok">Token</label>
      <PasswordInput id="tok" />
    </>,
  );
  const field = screen.getByLabelText("Token");
  expect(field).toHaveAttribute("type", "password");
  expect(field).toHaveAttribute("autocomplete", "new-password");
  expect(field).toHaveAttribute("data-1p-ignore");
  await userEvent.click(screen.getByRole("button", { name: "Show value" }));
  expect(field).toHaveAttribute("type", "text");
  expect(screen.getByRole("button", { name: "Hide value" })).toBeInTheDocument();
});

test("the note line is always rendered, also without help or error", () => {
  const { container } = render(
    <FieldShell name="t" label="Title">
      {input}
    </FieldShell>,
  );
  expect(container.querySelector(".field-note")).toBeInTheDocument();
  expect(container.querySelector("[data-field]")).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).not.toHaveAttribute("aria-describedby");
});

test("extra describedBy ids are kept beside the visible note", () => {
  render(
    <FieldShell name="p" label="Projects" legend help="h" describedBy="marker">
      {() => <input aria-label="x" />}
    </FieldShell>,
  );
  expect(screen.getByRole("group", { name: "Projects" })).toHaveAttribute(
    "aria-describedby",
    "field-p-help marker",
  );
});

test("below renders after the note", () => {
  const { container } = render(
    <FieldShell name="t" label="T" below={<p>summary</p>}>
      {input}
    </FieldShell>,
  );
  const note = container.querySelector(".field-note")!;
  expect(note.nextElementSibling).toHaveTextContent("summary");
});

test("a warning describes the control but doesn't mark it invalid", () => {
  render(
    <FieldShell name="tok" label="Token" warning="Couldn't reach Claude. Try again.">
      {input}
    </FieldShell>,
  );
  const el = screen.getByLabelText("Token");
  expect(el).toHaveAccessibleDescription("Couldn't reach Claude. Try again.");
  expect(el).not.toBeInvalid();
});

test("TokenField shows a warning in its note, not in a second alert", () => {
  render(
    <TokenField
      name="credential-value"
      label="Token"
      value=""
      onChange={() => {}}
      verdict={{ warning: "Couldn't reach Claude. Try again." }}
    />,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByLabelText("Token")).toHaveAccessibleDescription(
    "Couldn't reach Claude. Try again.",
  );
});

test("TokenField shows the OAuth help for oauth_token only", () => {
  const props = {
    name: "credential-value",
    label: "Token",
    value: "",
    onChange: () => {},
    verdict: {},
  };
  const { rerender } = render(<TokenField {...props} kind="oauth_token" />);
  expect(screen.getByLabelText("Token")).toHaveAccessibleDescription(
    "Create one with claude setup-token.",
  );
  rerender(<TokenField {...props} kind="api_key" />);
  expect(screen.getByLabelText("Token")).not.toHaveAccessibleDescription();
});

test("FormField puts its action in the label row and not on the input", () => {
  render(<FormField name="p" label="Path" action={<button type="button">Help</button>} />);
  const input = screen.getByLabelText("Path");
  expect(input).not.toHaveAttribute("action");
  expect(screen.getByRole("button", { name: "Help" })).toBeInTheDocument();
});
