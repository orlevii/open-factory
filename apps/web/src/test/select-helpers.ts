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

/** Opens a Combobox by its trigger and clicks the option. */
export async function pickComboOption(trigger: HTMLElement, name: string | RegExp) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole("option", { name }));
}

/** The open Combobox's option labels as shown (the current value's screen-reader ", selected" left
 *  out; closes it afterwards). */
export async function comboOptionNames(trigger: HTMLElement): Promise<string[]> {
  await userEvent.click(trigger);
  await screen.findByRole("listbox");
  const names = Array.from(document.querySelectorAll("[role=option]")).map((o) => {
    const copy = o.cloneNode(true) as HTMLElement;
    // The ", selected" mark and a human's initials: neither is part of the label.
    for (const sr of copy.querySelectorAll(".sr-only, [data-human-avatar]")) sr.remove();
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  });
  await userEvent.keyboard("{Escape}");
  return names;
}
