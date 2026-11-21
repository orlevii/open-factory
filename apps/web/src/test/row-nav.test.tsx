import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { onRowKeyDown } from "@/lib/row-nav";
import { installShortcuts, SINGLE_KEYS_PREF } from "@/lib/shortcuts";

afterEach(() => localStorage.clear());

function List() {
  return (
    <>
      <input aria-label="field" />
      <ul aria-label="rows" onKeyDown={onRowKeyDown}>
        {["a", "b", "c"].map((n) => (
          <li key={n}>
            <a href={`#${n}`} className="of-row" aria-current={n === "b" ? "true" : undefined}>
              {n}
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

test("j and k move focus like the arrow keys, clamped at the ends", async () => {
  const user = userEvent.setup();
  render(<List />);
  screen.getByRole("link", { name: "a" }).focus();
  await user.keyboard("j");
  expect(screen.getByRole("link", { name: "b" })).toHaveFocus();
  await user.keyboard("j");
  await user.keyboard("j");
  expect(screen.getByRole("link", { name: "c" })).toHaveFocus();
  await user.keyboard("k");
  expect(screen.getByRole("link", { name: "b" })).toHaveFocus();
  await user.keyboard("{ArrowUp}");
  expect(screen.getByRole("link", { name: "a" })).toHaveFocus();
});

test("j and k do nothing with a modifier held", async () => {
  const user = userEvent.setup();
  render(<List />);
  screen.getByRole("link", { name: "a" }).focus();
  await user.keyboard("{Control>}j{/Control}");
  expect(screen.getByRole("link", { name: "a" })).toHaveFocus();
});

test("j and k do nothing with the single-key switch off", async () => {
  const user = userEvent.setup();
  localStorage.setItem(SINGLE_KEYS_PREF, "off");
  const uninstall = installShortcuts();
  render(<List />);
  screen.getByRole("link", { name: "a" }).focus();
  await user.keyboard("j");
  expect(screen.getByRole("link", { name: "a" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("link", { name: "b" })).toHaveFocus();
  uninstall();
});

test("the current row carries the class the selected style hangs on", () => {
  render(<List />);
  const row = screen.getByRole("link", { name: "b" });
  expect(row).toHaveClass("of-row");
  expect(row).toHaveAttribute("aria-current", "true");
});
