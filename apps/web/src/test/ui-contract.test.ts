import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SRC, sourceFiles } from "./ui-contract-files";

const css = readFileSync(join(SRC, "styles.css"), "utf8");

describe("styles.css", () => {
  test("the loading mark animates only when motion is allowed", () => {
    const gate = css.match(
      /@media \(prefers-reduced-motion: no-preference\)\s*{[^}]*\.of-ignite\s*{[^}]*animation:\s*of-ignite/,
    );
    expect(gate).not.toBeNull();
    const outside = css.replace(
      /@media \(prefers-reduced-motion: no-preference\)\s*{[\s\S]*?}\s*}/g,
      "",
    );
    expect(outside).not.toMatch(/\.of-ignite\s*{[^}]*animation/);
  });
  test("keyboard-opened overlays never animate", () => {
    expect(css).toMatch(
      /\[data-instant\],\s*\[data-instant\] \*\s*{[^}]*animation:\s*none !important/,
    );
  });
});

describe("overlay surfaces", () => {
  for (const f of ["popover", "dropdown-menu", "tooltip", "select"]) {
    const path = join(SRC, `components/ui/${f}.tsx`);
    test.skipIf(!existsSync(path))(`${f}.tsx has no shadow and no slide-in`, () => {
      const src = readFileSync(path, "utf8");
      expect(src).not.toMatch(/\bshadow-/);
      expect(src).not.toContain("slide-in-from-");
    });
  }
});

describe("form controls", () => {
  const files = [
    "components/ui/button.tsx",
    "components/ui/input.tsx",
    "components/ui/textarea.tsx",
    "components/ui/checkbox.tsx",
    "components/native-select.tsx",
  ];
  for (const f of files) {
    test(`${f} uses the one base-layer focus ring`, () => {
      const src = readFileSync(join(SRC, f), "utf8");
      for (const bad of ["outline-none", "ring-3", "ring-ring/50", "focus-visible:ring-2"]) {
        expect(src).not.toContain(bad);
      }
    });
  }
});

describe("focus ring", () => {
  // Nothing hides the base 2px outline or swaps it for a ring halo, unless the line says why.
  const BAD =
    /(?<![\w-])(?:outline-none|outline-hidden|ring-3|ring-ring\/50|(?:[\w-]+:)*(?:focus-visible|has-focus-visible|focus-within|has-focus|focus):ring-\d|focus-within:ring-\[)/;
  test("no utility hides or replaces the focus ring", () => {
    const offenders = sourceFiles().flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          line.includes("ui-contract:allow") || !BAD.test(line)
            ? []
            : [`${f.replace(SRC, "")}:${i + 1}`],
        ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("loading", () => {
  test("only spinner.tsx spins", () => {
    const offenders = sourceFiles()
      .filter((f) => !f.endsWith("components/ui/spinner.tsx"))
      .filter((f) => readFileSync(f, "utf8").includes("animate-spin"))
      .map((f) => f.replace(SRC, ""));
    expect(offenders).toEqual([]);
  });
  test("skeletons are static", () => {
    expect(readFileSync(join(SRC, "components/ui/skeleton.tsx"), "utf8")).not.toContain(
      "animate-pulse",
    );
  });
});
