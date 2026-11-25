import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeTestApp } from "../test/helpers.ts";
import { skillDescription } from "./host-skills.ts";

const skills = mkdtempSync(path.join(tmpdir(), "hostskills-"));
const skill = (name: string, body?: string) => {
  mkdirSync(path.join(skills, name), { recursive: true });
  if (body !== undefined) writeFileSync(path.join(skills, name, "SKILL.md"), body);
};

let h: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
beforeAll(async () => {
  skill("tdd", "---\nname: tdd\ndescription: Write the test first.\n---\n# TDD\n");
  skill("long", `---\ndescription: ${"x".repeat(300)}\n---\n`);
  skill("folded", "---\ndescription: >\n  One line\n  from two.\n---\n");
  skill("bare", "# no frontmatter\n");
  skill("nofile");
  skill(".hidden", "---\ndescription: no\n---\n");
  writeFileSync(path.join(skills, "stray.md"), "x");
  mkdirSync(path.join(skills, "elsewhere"));
  writeFileSync(path.join(skills, "elsewhere", "SKILL.md"), "---\ndescription: linked\n---\n");
  symlinkSync(path.join(skills, "elsewhere"), path.join(skills, "link"));
  h = await makeTestApp({ env: { FACTORY_HOST_SKILLS_DIR: skills } });
  cookie = (await h.signUpUser()).cookie;
});
afterAll(() => h.close());

const get = () => h.app.inject({ method: "GET", url: "/api/host-skills", headers: { cookie } });

test("lists folders with a SKILL.md, descriptions cut to 200 characters", async () => {
  const r = await get();
  expect(r.statusCode).toBe(200);
  const body = r.json() as { dir: string; skills: { name: string; description: string }[] };
  expect(body.dir).toBe(skills);
  expect(body.skills.map((s) => s.name)).toEqual([
    "bare",
    "elsewhere",
    "folded",
    "link",
    "long",
    "tdd",
  ]);
  const by = Object.fromEntries(body.skills.map((s) => [s.name, s.description]));
  expect(by.tdd).toBe("Write the test first.");
  expect(by.long).toBe("x".repeat(200));
  expect(by.folded).toBe("One line from two.");
  expect(by.bare).toBe("");
  expect(by.link).toBe("linked");
});

test("requires a signed-in user", async () => {
  expect((await h.app.inject({ method: "GET", url: "/api/host-skills" })).statusCode).toBe(401);
});

test("a missing dir gives an empty list", async () => {
  const other = await makeTestApp({ env: { FACTORY_HOST_SKILLS_DIR: path.join(skills, "nope") } });
  try {
    const c = (await other.signUpUser()).cookie;
    const r = await other.app.inject({
      method: "GET",
      url: "/api/host-skills",
      headers: { cookie: c },
    });
    expect(r.json()).toEqual({ dir: path.join(skills, "nope"), skills: [] });
  } finally {
    await other.close();
  }
});

test("a malformed frontmatter has no description", () => {
  expect(skillDescription("---\ndescription: [\n---\n")).toBe("");
  expect(skillDescription("---\ndescription: 5\n---\n")).toBe("");
});
