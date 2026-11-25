import { readFileSync } from "node:fs";
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
  const rules = () => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{};]+){([^{}]*)}/g)];
  test("markdown headings and definition lists wrap long words like paragraphs do (#82)", () => {
    const anywhere = rules()
      .filter(([, , body]) => /overflow-wrap:\s*anywhere/.test(body ?? ""))
      .map(([, sel]) => (sel ?? "").trim());
    for (const el of ["h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd"])
      expect(
        anywhere.some((s) => s.startsWith(".prose-of") && new RegExp(`\\b${el}\\b`).test(s)),
        el,
      ).toBe(true);
  });
  test(".prose-of-work is a modifier on .prose-of, so it keeps every .prose-of rule", () => {
    const work = rules()
      .flatMap(([, sel]) => (sel ?? "").split(","))
      .map((s) => s.trim())
      .filter((s) => s.includes("prose-of-work"));
    expect(work.length).toBeGreaterThan(0);
    for (const s of work) expect(s.startsWith(".prose-of.prose-of-work")).toBe(true);
  });
});

describe("overlay surfaces", () => {
  for (const f of ["popover", "dropdown-menu", "tooltip", "select", "combobox"]) {
    const path = join(SRC, `components/ui/${f}.tsx`);
    test(`${f}.tsx has no shadow and no slide-in`, () => {
      const src = readFileSync(path, "utf8");
      expect(src).not.toMatch(/\bshadow-/);
      expect(src).not.toContain("slide-in-from-");
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

describe("secondary buttons", () => {
  // Decision 20: outline is only for page- or header-level standalone actions; actions inside a
  // section (section-header adds, inline-form Cancels, empty-state links) are ghost. A new outline
  // site is a deliberate choice: add it here with the reason.
  const OUTLINE: Record<string, number> = {
    "components/confirm-dialog.tsx": 1, // Cancel in a dialog
    "components/route-states.tsx": 1, // Go to Inbox on the error page
    "features/inbox/inbox-list.tsx": 1, // Load earlier
    "features/inbox/inbox-pane.tsx": 3, // Open in session / Open task in the pane header (spec §11.2); Open chat in a chat's strip; Sign in again: the pane's one standalone action
    "features/session/timeline.tsx": 1, // Load earlier
    "features/chat/chat-view.tsx": 1, // Load earlier
    "features/session/agent-details.tsx": 1, // Edit agent: the details footer's standalone action
    "components/composer/stop-button.tsx": 1, // Stop: the composer's one control on the running turn (U3 §6.1)
    "features/settings/credentials-section.tsx": 1, // Verify
    "features/tasks/task-detail.tsx": 1, // Edit beside the title
    "features/tasks/task-list.tsx": 1, // Load more
    "features/tasks/status-menu.tsx": 1, // a select-like field trigger, not an action
  };
  test("outline buttons appear only at the page-level sites named here", () => {
    const counts = Object.fromEntries(
      sourceFiles()
        .filter((f) => !f.includes("/components/ui/"))
        .map((f) => [
          f.replace(`${SRC}/`, ""),
          (readFileSync(f, "utf8").match(/variant="outline"/g) ?? []).length,
        ])
        .filter(([, n]) => n),
    );
    expect(counts).toEqual(OUTLINE);
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

describe("hit areas (U4 §11.3)", () => {
  const read = (f: string) => readFileSync(join(SRC, f), "utf8");
  // The element that holds `label`: the source from the last opening control tag before it to the label.
  const controlBefore = (src: string, label: string) => {
    const at =
      src.indexOf(`>${label}<`) >= 0
        ? src.indexOf(`>${label}<`)
        : src.search(new RegExp(`>\\s*${label}\\s*<`));
    if (at < 0) return undefined;
    const head = src.slice(0, at + 1);
    const open = Math.max(
      head.lastIndexOf("<Button"),
      head.lastIndexOf("<button"),
      head.lastIndexOf("<summary"),
    );
    return head.slice(open);
  };
  // Buttons among form fields grow for real instead of taking an expander over a field or prose.
  const FORM: [string, string][] = [
    ["features/agents/address-line.tsx", "Change"],
    ["features/agents/template-field.tsx", "New template"],
    ["features/agents/template-field.tsx", "Add secret"],
    ["features/agents/new-agent-sheet.tsx", "Add credential"],
    ["features/agents/edit-agent-sheet.tsx", "Add credential"],
    ["features/agents/project-grant-picker.tsx", "Add project"],
    ["features/schedules/repeats-field.tsx", "Cron help"],
    ["features/sheets/more-options.tsx", "More options"],
    ["features/sheets/form-footer.tsx", "Discard"],
    ["features/templates/new-template-form.tsx", "Change"],
  ];
  for (const [f, label] of FORM)
    test(`${f}: "${label}" is a form button (inForm), not an expander`, () => {
      const tag = controlBefore(read(f), label);
      expect(tag, label).toBeDefined();
      expect(tag).toMatch(/\binForm\b|\bIN_FORM\b|pointer-coarse:min-h-10/);
      expect(tag).not.toMatch(/\bhit-40\b/);
    });

  // An expander is clipped by an overflow-hidden ancestor: the known wrappers of header and toolbar icon
  // buttons never clip.
  const CLIP =
    /(?<![\w-])(?:overflow-hidden|overflow-clip|overflow-x-hidden|overflow-y-hidden|truncate)(?![\w-])/;
  const classOf = (src: string, marker: string, end: string) => {
    const from = src.indexOf(marker);
    expect(from, marker).toBeGreaterThanOrEqual(0);
    return src.slice(from, src.indexOf(end, from));
  };
  test("the expander is a 40px ::after on coarse pointers only", () => {
    const coarse = css.match(/@media \(pointer: coarse\)\s*{\s*\.hit-40::after\s*{([^}]*)}/);
    expect(coarse).not.toBeNull();
    const body = coarse?.[1] ?? "";
    expect(body).toMatch(/content:\s*""/);
    expect(body).toMatch(/position:\s*absolute/);
    for (const axis of ["inset-block", "inset-inline"])
      expect(body).toMatch(
        new RegExp(`${axis}:\\s*min\\(0px,\\s*calc\\(\\(100% - 2\\.5rem\\) / 2\\)\\)`),
      );
    // Nowhere else: a fine pointer never gets the box.
    expect(css.match(/\.hit-40/g)).toHaveLength(1);
  });
  test("PageHeader actions and SheetHeader are coarse icon groups (40px boxes, 4px apart)", () => {
    const header = read("components/page-header.tsx");
    expect(classOf(header, "{actions && (", "{actions}")).toContain("COARSE_ICON_GROUP");
    expect(
      classOf(read("components/ui/sheet.tsx"), 'data-slot="sheet-header"', "{...props}"),
    ).toContain("COARSE_ICON_GROUP");
  });
  test("no clipping wrapper around PageHeader, SheetHeader or composer toolbar icon buttons", () => {
    const header = read("components/page-header.tsx");
    expect(classOf(header, "<header", ">")).not.toMatch(CLIP);
    expect(classOf(header, "{actions && (", "{actions}")).not.toMatch(CLIP);
    expect(
      classOf(read("components/ui/sheet.tsx"), 'data-slot="sheet-header"', "{...props}"),
    ).not.toMatch(CLIP);
    expect(
      classOf(read("components/composer/composer.tsx"), "data-composer-toolbar", ">\n"),
    ).not.toMatch(CLIP);
  });
});

describe("I4 field errors", () => {
  test("form-outcome live regions never transition visibility", () => {
    expect(css).not.toMatch(/\.form-outcome-line[^{]*{[^}]*visibility/);
  });
});
