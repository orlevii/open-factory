import type { KeyboardEvent } from "react";

/** Arrow keys, Home and End also move between the link rows of a list; Tab still reaches every row. */
export function onRowKeyDown(e: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(e.key) || !(e.target instanceof HTMLAnchorElement)) return;
  const links = [...e.currentTarget.querySelectorAll<HTMLElement>("a")];
  const i = links.indexOf(e.target);
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? links.length - 1
        : Math.min(links.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)));
  e.preventDefault();
  links[next]?.focus();
}
