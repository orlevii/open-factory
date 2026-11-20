import { expect, test } from "vitest";
import { buildClaudeMd, type ClaudeMdInput } from "./claude-md.ts";

const input: ClaudeMdInput = {
  slug: "lead",
  displayName: "Team Lead",
  description: "Owns delivery.",
  template: "team-lead",
  manager: { slug: "cto", displayName: "CTO" },
  workdir: "/h/of/agents/lead",
  projects: [{ name: "app", hostPath: "/code/app" }],
  secretNames: ["GH_TOKEN"],
};
const sections = (md: string) => md.split("\n").filter((l) => l.startsWith("#"));

test("structure with everything present; deterministic", () => {
  const md = buildClaudeMd(input);
  expect(sections(md)).toEqual([
    "# Open Factory",
    "## Who you are",
    "## How messages reach you",
    "## Your workspace",
  ]);
  expect(md).toContain("@lead");
  expect(md).toContain("@cto");
  expect(md).toContain("./projects/app");
  expect(md).toContain("GH_TOKEN");
  expect(buildClaudeMd(input)).toBe(md);
  expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
});
test("no manager, no projects, no secrets", () => {
  const md = buildClaudeMd({ ...input, manager: null, projects: [], secretNames: [] });
  expect(md).toContain("No manager");
  expect(md).toContain("No projects are granted to you.");
  expect(md).not.toContain("Environment variables provided to you");
});
