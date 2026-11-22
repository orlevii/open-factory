import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** Opens a Radix Select by its trigger and clicks the option. `name` is the option's accessible name. */
export async function pickOption(trigger: HTMLElement, name: string | RegExp) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name }));
}

/** The listbox's option names, read from the open select (closes it afterwards). */
export async function optionNames(trigger: HTMLElement): Promise<string[]> {
  await userEvent.click(trigger);
  const listbox = await screen.findByRole("listbox");
  const names = Array.from(listbox.querySelectorAll("[role=option]")).map((o) =>
    (o.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
  await userEvent.keyboard("{Escape}");
  return names;
}
