import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

/** CodeMirror stays in its own chunk: features/config reaches it only through code-surface's lazy import. */
test("features/config never imports code-editor.tsx except as types", () => {
  const offenders = readdirSync(import.meta.dirname)
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) =>
      readFileSync(path.join(import.meta.dirname, f), "utf8")
        .split("\n")
        .some(
          (l) => /["']@\/features\/templates\/code-editor["']/.test(l) && !/^import type /.test(l),
        ),
    );
  expect(offenders).toEqual([]);
});
