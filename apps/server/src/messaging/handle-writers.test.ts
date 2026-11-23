import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const server = path.resolve(import.meta.dirname, "../..");
const INSERT =
  /insert\((?:schema\.)?(?:agents|users)\)|insert\s+into\s+(?:agents|users)\b|\.insert\(\s*(?:schema\.)?(?:agents|users)\s*\)/i;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(server, p).split(path.sep).join("/");
const writers = (files: string[]) =>
  files
    .filter((f) => INSERT.test(readFileSync(f, "utf8")))
    .map(rel)
    .sort();

// Every row in agents.slug and users.handle must reference a claimed handle (spec §4.1), so each place that inserts
// one claims through claimHandle first. This lists them: a new writer fails here until it claims and is named.
test("only agent create and spawn insert agents; the auth hook (better-auth) inserts users", () => {
  const production = walk(path.join(server, "src")).filter(
    (f) => !f.endsWith(".test.ts") && !/\/src\/(test|agents\/testing)\//.test(f),
  );
  expect(writers(production)).toEqual([
    "src/agents/agent-service.ts",
    "src/spawning/spawn-service.ts",
  ]);
  for (const f of ["agents/agent-service.ts", "spawning/spawn-service.ts"])
    expect(readFileSync(path.join(server, "src", f), "utf8")).toContain("claimHandle(tx");
});

test("fixtures and smoke scripts that insert agents or users claim through the test helper", () => {
  const fixtures = [
    ...walk(path.join(server, "scripts")),
    ...walk(path.join(server, "src/test")),
    ...walk(path.join(server, "src/agents/testing")),
  ];
  const inserting = fixtures.filter((f) => INSERT.test(readFileSync(f, "utf8")));
  expect(inserting.length).toBeGreaterThan(0);
  for (const f of inserting) expect(readFileSync(f, "utf8"), rel(f)).toMatch(/claimTestHandle/);
});
