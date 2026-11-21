import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { type ComboOption, Combobox } from "./combobox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

const OPTIONS: ComboOption[] = [
  { value: "", label: "None", fixed: true },
  { value: "alpha", label: "Alpha", keywords: ["first"] },
  { value: "beta", label: "Beta" },
  { value: "gamma", label: "Gamma", group: "Ended" },
];

function setup(props: Partial<React.ComponentProps<typeof Combobox>> = {}) {
  const onValueChange = vi.fn();
  render(
    <Combobox
      value=""
      onValueChange={onValueChange}
      options={OPTIONS}
      placeholder="Pick one"
      emptyText="No match."
      aria-label="Manager"
      {...props}
    />,
  );
  const trigger = screen.getByRole("combobox", { name: "Manager" });
  return { trigger, onValueChange };
}

const content = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]');
const optionNames = () =>
  screen.getAllByRole("option").map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim());
const highlighted = () =>
  screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true");

test("arrows move the highlight but never commit; Enter commits; click commits", async () => {
  const { trigger, onValueChange } = setup();
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  const before = highlighted();
  await userEvent.keyboard("{ArrowDown}");
  expect(highlighted()).not.toBe(before);
  await userEvent.keyboard("{ArrowDown}{ArrowUp}{ArrowDown}");
  expect(onValueChange).not.toHaveBeenCalled();
  expect(content()).not.toBeNull();
  await userEvent.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenCalledTimes(1);
  expect(onValueChange).toHaveBeenCalledWith("beta");
  await vi.waitFor(() => expect(content()).toBeNull());

  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name: "Alpha" }));
  expect(onValueChange).toHaveBeenLastCalledWith("alpha");
  await vi.waitFor(() => expect(content()).toBeNull());
});

test("filters by label and keywords; fixed options stay while filtering", async () => {
  const { trigger } = setup();
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  await userEvent.keyboard("first");
  await vi.waitFor(() => expect(optionNames()).toEqual(["None", "Alpha"]));
  await userEvent.clear(screen.getByRole("combobox", { name: "Search" }));
  await userEvent.keyboard("gam");
  await vi.waitFor(() => expect(optionNames()).toEqual(["None", "Gamma"]));
  await userEvent.keyboard("zzzz");
  await vi.waitFor(() => expect(optionNames()).toEqual(["None"]));
});

test("shows the empty text when nothing matches and there is no fixed option", async () => {
  const { trigger } = setup({ options: OPTIONS.filter((o) => !o.fixed) });
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  await userEvent.keyboard("zzzz");
  expect(await screen.findByText("No match.")).toBeInTheDocument();
});

test("order: fixed options, then the current value, then the rest; the current value is highlighted", async () => {
  const { trigger } = setup({ value: "beta" });
  await userEvent.click(trigger);
  const listbox = await screen.findByRole("listbox");
  expect(optionNames()).toEqual(["None", "Beta", "Alpha", "Gamma"]);
  expect(highlighted()?.textContent).toContain("Beta");
  expect(within(listbox).getByText("Ended")).toBeInTheDocument();
});

describe("trigger", () => {
  test("trigger looks like Select (same data-slot/classes contract as select trigger)", () => {
    render(
      <Select>
        <SelectTrigger aria-label="Native">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="x">X</SelectItem>
        </SelectContent>
      </Select>,
    );
    const select = screen.getByRole("combobox", { name: "Native" });
    const { trigger } = setup({ options: OPTIONS.filter((o) => !o.fixed) });
    expect(trigger.className).toBe(select.className);
    expect(trigger).toHaveAttribute("data-slot", "combobox-trigger");
    expect(trigger).toHaveAttribute("data-placeholder");
    expect(trigger).toHaveTextContent("Pick one");
    expect(trigger.querySelector("svg")).not.toBeNull();
  });

  test("shows the selected label; an unknown value renders as itself or through renderValue", () => {
    const { unmount } = render(
      <Combobox value="alpha" onValueChange={() => {}} options={OPTIONS} aria-label="A" />,
    );
    expect(screen.getByRole("combobox", { name: "A" })).toHaveTextContent("Alpha");
    expect(screen.getByRole("combobox", { name: "A" })).not.toHaveAttribute("data-placeholder");
    unmount();
    const { unmount: u2 } = render(
      <Combobox value="@ghost" onValueChange={() => {}} options={OPTIONS} aria-label="B" />,
    );
    expect(screen.getByRole("combobox", { name: "B" })).toHaveTextContent("@ghost");
    u2();
    render(
      <Combobox
        value="ghost"
        onValueChange={() => {}}
        options={OPTIONS}
        aria-label="C"
        renderValue={(v) => <b>chip {v}</b>}
      />,
    );
    expect(screen.getByRole("combobox", { name: "C" })).toHaveTextContent("chip ghost");
  });
});

test("popover width at least 24rem, side locked while open, list height fixed (h-72)", async () => {
  const { trigger } = setup();
  await userEvent.click(trigger);
  const listbox = await screen.findByRole("listbox");
  const c = content();
  expect(c?.className).toMatch(/w-\[max\(var\(--radix-popover-trigger-width\),min\(24rem,/);
  expect(listbox).toHaveClass("h-72");
  expect(listbox.className).not.toMatch(/cmdk-list-height/);

  // The side chosen at open stays: simulate the open landing on top, then narrow the filter.
  const wrapper = c?.parentElement as HTMLElement;
  await vi.waitFor(() => expect(wrapper.style.transform).not.toMatch(/-200%/));
  const placedBelow = wrapper.style.transform;
  c?.setAttribute("data-side", "top");
  await userEvent.keyboard("a");
  await vi.waitFor(() => expect(wrapper.style.transform).not.toBe(placedBelow));
  expect(c).toHaveAttribute("data-side", "top");
});

test("keyboard-opened popover is stamped data-instant", async () => {
  const { trigger } = setup();
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(content()).toHaveAttribute("data-instant"));
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(content()).toBeNull());
  await userEvent.click(trigger);
  await vi.waitFor(() => expect(content()).not.toBeNull());
  expect(content()).not.toHaveAttribute("data-instant");
});
