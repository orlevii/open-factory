import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { SRC, sourceFiles } from "./ui-contract-files";

describe("radios and checkboxes", () => {
  test('type="radio" and type="checkbox" live only in the segmented control', () => {
    const offenders = sourceFiles()
      .filter((f) => !f.endsWith("components/ui/segmented-control.tsx"))
      .filter((f) => /type=["']?(radio|checkbox)["']?/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(SRC, ""));
    expect(offenders).toEqual([]);
  });
});

describe("native tooltips", () => {
  test("no title= on a Button or Link outside components/ui (ui-contract:allow with a reason where it is not a tooltip)", () => {
    const offenders = sourceFiles()
      .filter((f) => !f.includes("/components/ui/"))
      .flatMap((f) => {
        const src = readFileSync(f, "utf8");
        // Blank out `=>` so an arrow function inside a prop does not end the tag early.
        const tags = src.replace(/=>/g, "  ").match(/<(?:Button|Link)\b[^>]*>/g) ?? [];
        return tags
          .filter((tag) => /\btitle=/.test(tag) && !tag.includes("ui-contract:allow"))
          .map((tag) => `${f.replace(SRC, "")}: ${tag.slice(0, 60)}`);
      });
    expect(offenders).toEqual([]);
  });
});

describe("row menus", () => {
  // U4 §11.1: every row and header menu is an AdaptiveMenu (a drawer on phones). A bare DropdownMenu
  // in features is a picker, not a row menu: name it here.
  const PICKERS = ["features/tasks/status-menu.tsx"];
  test("no feature keeps a bare DropdownMenu except the pickers", () => {
    const users = sourceFiles()
      .filter((f) => f.includes("/features/") && !/\.test\.tsx?$/.test(f))
      .filter((f) => /\bDropdownMenu/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(`${SRC}/`, ""));
    expect(users).toEqual(PICKERS);
  });
});
