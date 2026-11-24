import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeClaude } from "@open-factory/harness/testing";
import { afterAll, beforeAll, expect, test } from "vitest";
import { makeAcmeMarketplace } from "../library/testing/acme-marketplace.ts";
import { makeTestApp } from "../test/helpers.ts";

/**
 * I5 §7.1, §8.3: a marketplace update moves only the Library's commit. A running agent of a template that uses the
 * marketplace gets no `config_changed` event and no restart, and the template keeps its own pin. Needs Postgres, so it
 * runs in CI; the real Claude driver runs against the fake `claude`, which installs the declared plugin at start.
 */
let t: Awaited<ReturnType<typeof makeTestApp>>;
let cookie: string;
let tmp: string;
let fake: ReturnType<typeof createFakeClaude>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "of-mktupd-"));
  fake = createFakeClaude({
    scenario: "reply",
    env: { FAKE_CLAUDE_GITHUB_URL: `file://${tmp}/gh` },
  });
  t = await makeTestApp({
    env: { FACTORY_CLAUDE_BIN: fake.bin, FACTORY_GITHUB_URL: `file://${tmp}/gh` },
  });
  cookie = (await t.signUpUser({ handle: "or" })).cookie;
});
afterAll(() => t.close());

const call = (method: "GET" | "POST", url: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

const until = async (pred: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 250; i++) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
};

const starts = () => fake.log().filter((e) => e.kind === "start" && !e.argv.includes("--version"));
const eventTypes = async () =>
  (
    (await call("GET", "/api/agents/dev/events")).json().events as { event: { type: string } }[]
  ).map((e) => e.event.type);

test("updating a marketplace restarts no agent and sends no config_changed", async () => {
  const made = await makeAcmeMarketplace(tmp);
  const second = made.repoShas[1] as string;
  const preview = await call("POST", "/api/library/marketplaces/preview", {
    kind: "github",
    repo: "acme/mk",
  });
  expect(
    (await call("POST", "/api/library/marketplaces", { previewId: preview.json().previewId }))
      .statusCode,
  ).toBe(201);
  // The template pins the Library's commit, as a pick in the form would.
  await t.seedAgent({ slug: "dev" });
  writeFileSync(
    path.join(t.factoryHome, "templates", "test", "settings.json"),
    JSON.stringify({
      extraKnownMarketplaces: {
        acme: { source: { source: "github", repo: "acme/mk", ref: second } },
      },
      enabledPlugins: { "rel@acme": true },
    }),
  );
  await t.app.templates.scan();

  // Start the agent: its process runs with the plugin declared at the template's pin.
  expect(
    (await call("POST", "/api/messages", { to: ["dev"], body: "hi", urgent: false })).statusCode,
  ).toBe(202);
  await until(
    async () =>
      (await call("GET", "/api/agents/dev")).json().agent.status === "idle" && starts().length > 0,
  );
  const rt = await t.app.runtimes.bySlug("dev");
  if (!rt) throw new Error("no runtime");
  await rt.settled();
  expect(rt.hasProcess()).toBe(true);
  const startedBefore = starts().length;
  const typesBefore = await eventTypes();
  expect(typesBefore).not.toContain("config_changed");

  // The marketplace moves to a newer commit: Check, then Update.
  const repo = path.join(tmp, "gh", "acme", "mk.git");
  writeFileSync(path.join(repo, "plugins", "rel", "a.js"), "console.log('a3')\n");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: repo, GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    ).trim();
  git("add", "-A");
  git("commit", "-q", "-m", "third");
  const third = git("rev-parse", "HEAD");
  const checked = await call("POST", "/api/library/marketplaces/acme/check");
  expect(checked.json()).toMatchObject({ commit: second, updateCommit: third });
  const updated = await call("POST", "/api/library/marketplaces/acme/update", { commit: third });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ commit: third });

  // Give any (wrong) restart or change flow time to run, then look.
  await t.app.marketplaces.idle();
  await new Promise((r) => setTimeout(r, 300));
  await rt.settled();
  expect(rt.hasProcess()).toBe(true);
  expect(starts()).toHaveLength(startedBefore);
  expect(await eventTypes()).toEqual(typesBefore);
  // The template still pins the commit it declared, and the Library holds the checkout it runs at.
  expect((await call("GET", "/api/agents/dev/config")).json().plugins).toEqual([
    { key: "rel@acme", pin: `commit:${second}` },
  ]);
  const view = (await call("GET", "/api/library/plugins")).json().marketplaces[0];
  expect(view.commit).toBe(third);
});
