import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { type ComboOption, Combobox } from "./combobox";

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
/** Each row's visible text (the current value's screen-reader ", selected" left out). */
const optionNames = () =>
  screen.getAllByRole("option").map((o) => {
    const copy = o.cloneNode(true) as HTMLElement;
    for (const sr of copy.querySelectorAll(".sr-only")) sr.remove();
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  });
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
  test("an empty trigger shows its placeholder and a chevron", () => {
    const { trigger } = setup({ options: OPTIONS.filter((o) => !o.fixed) });
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

test("the popover keeps the side it opened on while the filter narrows", async () => {
  const { trigger } = setup();
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  const c = content();

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

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON() {} }) as DOMRect;
const translateX = (el: HTMLElement) => /translate\(([-\d.]+)px/.exec(el.style.transform)?.[1];

test("locking the side keeps the popover's horizontal place (a shifted popover doesn't snap back)", async () => {
  const { trigger } = setup();
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(300, 0, 100, 32));
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  const c = content() as HTMLElement;
  const wrapper = c.parentElement as HTMLElement;
  await vi.waitFor(() => expect(translateX(wrapper)).toBe("300"));
  // Simulate collision shift having moved the open popover 60px left to stay in the viewport.
  vi.spyOn(c, "getBoundingClientRect").mockReturnValue(rect(240, 36, 384, 330));
  await userEvent.keyboard("a");
  await vi.waitFor(() => expect(translateX(wrapper)).toBe("240"));
});

test("ArrowDown or ArrowUp on the closed trigger opens it, stamped data-instant, without committing", async () => {
  const { trigger, onValueChange } = setup();
  for (const key of ["{ArrowDown}", "{ArrowUp}"]) {
    trigger.focus();
    await userEvent.keyboard(key);
    await vi.waitFor(() => expect(content()).toHaveAttribute("data-instant"));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(content()).toBeNull());
  }
  expect(onValueChange).not.toHaveBeenCalled();
});

test("typing then Enter commits the best match, not the fixed option kept on top", async () => {
  const { trigger, onValueChange } = setup();
  await userEvent.click(trigger);
  await userEvent.type(await screen.findByRole("combobox", { name: "Search" }), "bet");
  await vi.waitFor(() => expect(highlighted()).toHaveTextContent("Beta"));
  await userEvent.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenCalledWith("beta");
});

test("one renderOption draws every non-trigger row; id, disabled and describedby reach the trigger", async () => {
  const renderOption = (o: ComboOption) => <b data-testid="row">{o.label.toUpperCase()}</b>;
  const { trigger } = setup({ renderOption, id: "f-mgr", "aria-describedby": "h", "aria-invalid": true });
  expect(trigger).toHaveAttribute("id", "f-mgr");
  expect(trigger).toHaveAttribute("aria-describedby", "h");
  expect(trigger).toHaveAttribute("aria-invalid", "true");
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  expect(screen.getAllByTestId("row").map((r) => r.textContent)).toEqual(
    expect.arrayContaining(["ALPHA", "BETA", "GAMMA", "NONE"]),
  );
});

test("disabled cannot be opened by click or keyboard", async () => {
  const { trigger, onValueChange } = setup({ disabled: true });
  expect(trigger).toBeDisabled();
  await userEvent.click(trigger);
  expect(screen.queryByRole("listbox")).toBeNull();
  trigger.focus();
  await userEvent.keyboard("{Enter}{ArrowDown} ");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onValueChange).not.toHaveBeenCalled();
});

test("a long value renders whole in the trigger's value slot", () => {
  const long = "A very long option label that cannot possibly fit in the trigger".repeat(3);
  const { trigger } = setup({ options: [{ value: "x", label: long }], value: "x" });
  const slot = trigger.querySelector<HTMLElement>('[data-slot="combobox-value"]');
  expect(slot).not.toBeNull();
  const text = slot?.firstElementChild;
  expect(text).toHaveTextContent(long);
});

test("a rendered value is a direct child of the slot, so it shrinks with it", () => {
  const { trigger } = setup({
    options: [{ value: "x", label: "X" }],
    value: "x",
    renderValue: () => <span data-testid="chip">chip</span>,
  });
  const slot = trigger.querySelector('[data-slot="combobox-value"]');
  expect(screen.getByTestId("chip").parentElement).toBe(slot);
});

test("the popover and its listbox are named after the combobox", async () => {
  const { trigger } = setup();
  await userEvent.click(trigger);
  expect(await screen.findByRole("listbox", { name: "Manager" })).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Manager" })).toBeInTheDocument();
});

test("the current value's row says it is selected to a screen reader, not only with a check", async () => {
  const { trigger } = setup({ value: "beta" });
  await userEvent.click(trigger);
  const row = await screen.findByRole("option", { name: /^Beta/ });
  expect(row).toHaveAccessibleName("Beta, selected");
  expect(screen.getByRole("option", { name: "Alpha" })).toBeInTheDocument();
});

function multi() {
  const announce = vi.fn();
  const onValueChange = vi.fn();
  const options: ComboOption[] = [
    { value: "tdd", label: "tdd" },
    { value: "review", label: "review" },
    { value: "debug", label: "debug" },
  ];
  function Host({ names }: { names: string[] }) {
    const added = React.useMemo(() => new Set(names), [names.join("\0")]);
    return (
      <Combobox
        value=""
        onValueChange={(v) => {
          onValueChange(v);
          setNames((n) => [...n, v]);
        }}
        options={options}
        aria-label="Skills"
        multiple={{ added, announce }}
        trigger={<button type="button">Add skill</button>}
      />
    );
  }
  let setNames: React.Dispatch<React.SetStateAction<string[]>> = () => {};
  function Wrap() {
    const [names, set] = React.useState<string[]>([]);
    setNames = set;
    return <Host names={names} />;
  }
  render(<Wrap />);
  return { announce, onValueChange };
}

test("multi: Enter adds, stays open, marks Added, moves the highlight, announces", async () => {
  const { announce, onValueChange } = multi();
  await userEvent.click(screen.getByRole("button", { name: "Add skill" }));
  const list = await screen.findByRole("listbox");
  expect(list).not.toHaveAttribute("aria-multiselectable");
  await userEvent.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenCalledWith("tdd");
  expect(announce).toHaveBeenCalledWith("Added tdd");
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  const [first] = screen.getAllByRole("option");
  expect(first).toHaveAttribute("aria-disabled", "true");
  expect(first).toHaveTextContent("Added");
  expect(highlighted()).toHaveTextContent("review");
  await userEvent.keyboard("{Enter}");
  expect(announce).toHaveBeenLastCalledWith("Added review");
});

test("multi: options added before the popover opens are left out", async () => {
  multi();
  await userEvent.click(screen.getByRole("button", { name: "Add skill" }));
  await screen.findByRole("listbox");
  await userEvent.keyboard("{Enter}{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Add skill" }));
  await screen.findByRole("listbox");
  expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["review", "debug"]);
});

test("multi with a caller trigger: the first pick keeps the popover's horizontal place", async () => {
  multi();
  const trigger = screen.getByRole("button", { name: "Add skill" });
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect(300, 0, 100, 32));
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  const c = content() as HTMLElement;
  const wrapper = c.parentElement as HTMLElement;
  await vi.waitFor(() => expect(translateX(wrapper)).toBe("300"));
  // Collision shift had moved the open popover 60px left; the first pick locks it where it is.
  vi.spyOn(c, "getBoundingClientRect").mockReturnValue(rect(240, 36, 384, 330));
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(translateX(wrapper)).toBe("240"));
});

test("multi: a filter with no match says so, instead of the empty-list text", async () => {
  multi();
  await userEvent.click(screen.getByRole("button", { name: "Add skill" }));
  await screen.findByRole("listbox");
  await userEvent.keyboard("zzz");
  expect(screen.getByText("No matches.")).toBeInTheDocument();
});
