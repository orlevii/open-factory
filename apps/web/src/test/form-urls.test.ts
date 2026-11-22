import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { expect, test } from "vitest";
import { SRC, sourceFiles } from "./ui-contract-files";

// Spec §2.1: nothing in the app navigates to a form URL; the legacy routes only redirect (§5.4).
// The edit URLs join this list when their sheets land (Edit agent, PR2 Task 23).
const FORM_URLS = ["/agents/new", "/tasks/new", "/schedules/new", "/templates/new"];
const REDIRECTS = new Set([
  "routes/_app/agents.new.tsx",
  "routes/_app/tasks.new.tsx",
  "routes/_app/schedules.new.tsx",
  "routes/_app/templates.new.tsx",
]);

test("no in-app link, navigate or palette action points at a create form URL", () => {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    const rel = relative(SRC, file);
    if (REDIRECTS.has(rel) || rel.startsWith("test/")) continue;
    const src = readFileSync(file, "utf8");
    for (const url of FORM_URLS)
      if (src.includes(`"${url}"`) || src.includes(`'${url}'`)) hits.push(`${rel}: ${url}`);
  }
  expect(hits).toEqual([]);
});
