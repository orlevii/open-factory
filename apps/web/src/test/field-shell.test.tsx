import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { FieldShell } from "@/components/field-shell";
import { FormField } from "@/components/form-field";
import { PasswordInput } from "@/components/password-input";

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
