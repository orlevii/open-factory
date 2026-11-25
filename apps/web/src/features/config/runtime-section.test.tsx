import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { QueryWrap } from "@/test/config-harness";
import { json, mockApi } from "@/test/mock-api";
import { ConfigForm } from "./config-form";
import { RUNTIME_COPY } from "./messages";

const DEFAULT_IMAGE = "ghcr.io/acme/base:latest";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

function factory(allowLocalRuntime: boolean) {
  mockApi({
    "GET /api/settings/factory": () =>
      json({
        warmWindowMinutes: 70,
        memberUpdateDebounceSeconds: 30,
        allowLocalRuntime,
        defaultImage: DEFAULT_IMAGE,
        updatedAt: null,
        updatedBy: null,
      }),
  });
}

function Form({
  template,
  onValue,
}: {
  template: Record<string, unknown>;
  onValue?: (v: unknown) => void;
}) {
  const [value, setValue] = useState<unknown>({ template });
  return (
    <QueryWrap>
      <ConfigForm
        mode="template"
        value={value}
        issues={[]}
        onChange={(u) =>
          setValue((p: unknown) => {
            const n = u(p);
            onValue?.(n);
            return n;
          })
        }
      />
    </QueryWrap>
  );
}

const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];
const local = () => screen.getByRole("radio", { name: "Local" });
const bypass = () => screen.getByRole("radio", { name: "Bypass" });

test("when the factory refuses Local, the Local segment is aria-disabled, focusable, described by the always-visible note, and picking it changes nothing", async () => {
  factory(false);
  const onValue = vi.fn();
  render(<Form template={{}} onValue={onValue} />);
  await waitFor(() => expect(local()).toHaveAttribute("aria-disabled", "true"));
  expect(local()).toHaveAccessibleDescription(
    /Disabled on this factory: set FACTORY_ALLOW_LOCAL_RUNTIME on the server/,
  );
  expect(screen.getByRole("radio", { name: "Docker" })).toBeChecked();
  await userEvent.click(local());
  expect(onValue).not.toHaveBeenCalled();
  expect(screen.getByRole("radio", { name: "Docker" })).toBeChecked();
  local().focus();
  expect(local()).toHaveFocus();
});

test("a stored Local on a factory that refuses it stays selected with its error", async () => {
  factory(false);
  render(<Form template={{ runtime: "local" }} />);
  await waitFor(() => expect(local()).toHaveAttribute("aria-disabled", "true"));
  expect(local()).toBeChecked();
  expect(document.getElementById("field-runtime-error")).toHaveTextContent(
    /Disabled on this factory/,
  );
});

test("picking Local while Bypass is selected switches to Auto with a note and disables Bypass", async () => {
  factory(true);
  const onValue = vi.fn();
  render(<Form template={{ permission_mode: "bypass" }} onValue={onValue} />);
  expect(bypass()).toBeChecked();
  expect(bypass()).not.toHaveAttribute("aria-disabled");
  await userEvent.click(local());
  expect(last(onValue)).toEqual({ template: { runtime: "local", permission_mode: "auto" } });
  expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
  expect(screen.getByText(RUNTIME_COPY.switchedToAuto)).toBeInTheDocument();
  expect(bypass()).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(bypass());
  expect(screen.getByRole("radio", { name: "Auto" })).toBeChecked();
  // Back on Docker, Bypass is available again.
  await userEvent.click(screen.getByRole("radio", { name: "Docker" }));
  expect(bypass()).not.toHaveAttribute("aria-disabled");
  expect(screen.queryByText(RUNTIME_COPY.switchedToAuto)).toBeNull();
});

test("on Local the image field stays in place, disabled, with its note", async () => {
  factory(true);
  render(<Form template={{ runtime: "local", image: "my/img:1" }} />);
  const image = screen.getByRole("textbox", { name: "Image" });
  expect(image).toBeDisabled();
  expect(image).toHaveValue("my/img:1");
  expect(image).toHaveAccessibleDescription(RUNTIME_COPY.imageNotUsed);
});

test("the image note names the factory default, and a typed image is written and cleared", async () => {
  factory(true);
  const onValue = vi.fn();
  render(<Form template={{}} onValue={onValue} />);
  const image = screen.getByRole("textbox", { name: "Image" });
  await waitFor(() => expect(image).toHaveAccessibleDescription(new RegExp(DEFAULT_IMAGE)));
  expect(image).not.toHaveAttribute("placeholder");
  await userEvent.type(image, "my/img:1");
  expect(last(onValue)).toEqual({ template: { image: "my/img:1" } });
  await userEvent.clear(image);
  expect(last(onValue)).toEqual({ template: {} });
});

test("an invalid image reference is refused when the field is left", async () => {
  factory(true);
  render(<Form template={{}} />);
  const image = screen.getByRole("textbox", { name: "Image" });
  await userEvent.type(image, "not a ref");
  await userEvent.tab();
  expect(image).toBeInvalid();
});
