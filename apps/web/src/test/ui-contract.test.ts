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
  test("keyboard-opened overlays never animate, but what they contain still can", () => {
    expect(css).toMatch(
      /\[data-instant\]:not\(:root\),\s*:root\[data-instant\] \*\s*{[^}]*animation:\s*none !important/,
    );
    expect(css).toMatch(
      /\[data-instant\],\s*\[data-instant\] \*\s*{[^}]*transition-duration:\s*0s !important/,
    );
    // A stamped overlay must not freeze its descendants (a pending Spinner keeps turning).
    const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]+){([^{}]*)}/g)];
    const descendantFreeze = rules.filter(
      ([, sel, body]) =>
        /animation:\s*none/.test(body ?? "") &&
        (sel ?? "").split(",").some((s) => /(^|[^\w)])\[data-instant\] \*/.test(s.trim())),
    );
    expect(descendantFreeze).toEqual([]);
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
  test("every outline width is the one 2px signal ring", () => {
    // outline-3, outline-[3px], focus-visible:after:outline-1 ...; outline-offset-* is not a width.
    const WIDTH = /(?<![\w-])(?:[\w-]+:)*-?outline-(?:(?!2(?![\w-]))\d+(?![\w-])|\[\d[^\]]*\])/;
    const offenders = sourceFiles().flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .flatMap((line, i) => (WIDTH.test(line) ? [`${f.replace(SRC, "")}:${i + 1}`] : [])),
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

describe("selects", () => {
  test("NativeSelect is imported only by the timezone select", () => {
    const offenders = sourceFiles()
      .filter((f) => !f.endsWith("components/native-select.tsx"))
      .filter((f) => readFileSync(f, "utf8").includes("components/native-select"))
      .map((f) => f.replace(SRC, ""));
    expect(offenders).toEqual(["/features/schedules/timezone-select.tsx"]);
  });
});

describe("radios and checkboxes", () => {
  test('type="radio" and type="checkbox" live only in the segmented control', () => {
    const offenders = sourceFiles()
      .filter((f) => !f.endsWith("components/ui/segmented-control.tsx"))
      .filter((f) => /type=["']?(radio|checkbox)["']?/.test(readFileSync(f, "utf8")))
      .map((f) => f.replace(SRC, ""));
    expect(offenders).toEqual([]);
  });
});

describe("disabled buttons", () => {
  test("no per-site disabled patches; the Button base style owns the disabled look", () => {
    const BAD = /aria-disabled:(?:opacity-50|hover:bg-transparent)/;
    const offenders = sourceFiles().filter(
      (f) => !f.includes("components/ui/sidebar.tsx") && BAD.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
  test("no Button carries its own opacity-50 outside components/ui", () => {
    const offenders = sourceFiles()
      .filter((f) => !f.includes("/components/ui/"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return src
          .split(/(?=<Button\b)/)
          .slice(1)
          .some((chunk) =>
            /className=[^\n]*\bopacity-50/.test(chunk.split(/<\/Button>|\n\s*>\n/)[0] ?? ""),
          );
      })
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
