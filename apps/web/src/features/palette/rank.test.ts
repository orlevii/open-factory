import type { AgentSummary } from "@open-factory/shared";
import { describe, expect, test } from "vitest";
import { ACTIONS, GO_TO, isTaskKey, rankAgents } from "./rank";

const a = (slug: string, displayName = slug): AgentSummary =>
  ({ slug, displayName }) as unknown as AgentSummary;
const slugs = (r: { agent: AgentSummary }[]) => r.map((x) => x.agent.slug);

describe("rankAgents", () => {
  test("exact slug beats exact name beats prefix beats recent beats substring", () => {
    const live = [
      a("xbotx", "has bot inside"), // substring
      a("recent-one", "Zed bot"), // recent + substring
      a("botany", "Botany"), // prefix
      a("other", "bot"), // exact name
      a("bot", "Something"), // exact slug
    ];
    const r = rankAgents("bot", live, [], ["recent-one"], []);
    expect(slugs(r)).toEqual(["bot", "other", "botany", "recent-one", "xbotx"]);
  });

  test("ties fall back to tree order", () => {
    const live = [a("alpha-2"), a("alpha-1"), a("alpha-3")];
    const r = rankAgents("alpha", live, [], [], ["alpha-3", "alpha-1", "alpha-2"]);
    expect(slugs(r)).toEqual(["alpha-3", "alpha-1", "alpha-2"]);
  });

  test("live agents come before ended ones, whatever the match quality", () => {
    const r = rankAgents("dev", [a("my-dev")], [a("dev")], [], []);
    expect(r.map((x) => [x.agent.slug, x.ended])).toEqual([
      ["my-dev", false],
      ["dev", true],
    ]);
  });

  test("an empty query lists only recent agents, in recent order", () => {
    const live = [a("a"), a("b"), a("c")];
    const r = rankAgents("  ", live, [a("gone")], ["c", "gone", "missing", "a"], ["a", "b", "c"]);
    expect(r.map((x) => [x.agent.slug, x.ended])).toEqual([
      ["c", false],
      ["gone", true],
      ["a", false],
    ]);
  });

  test("a recent agent that does not match the query is not listed", () => {
    expect(rankAgents("zzz", [a("ceo")], [], ["ceo"], [])).toEqual([]);
  });

  test("matching is case-insensitive and ignores a leading @", () => {
    expect(slugs(rankAgents("@CEO", [a("ceo", "Chief")], [], [], []))).toEqual(["ceo"]);
  });

  test("190 'Developer NNN' do not bury ceo for the query c", () => {
    const devs = Array.from({ length: 190 }, (_, i) =>
      a(`dev-${i}`, `Developer ${String(i).padStart(3, "0")}`),
    );
    const live = [...devs, a("ceo", "Chief Executive")];
    const tree = live.map((x) => x.slug);
    // Prefix: ceo beats the 190 devs, which only contain a c ("Developer" has no c; "dev-" none).
    expect(rankAgents("c", live, [], [], tree)[0]?.agent.slug).toBe("ceo");
    // Recent and prefix still lead among agents that merely contain the letter.
    const noisy = devs.map((d) => a(d.slug, `Pace ${d.slug}`));
    const withCeo = [...noisy, a("ceo", "Boss c")];
    const r = rankAgents(
      "c",
      withCeo,
      [],
      ["ceo"],
      withCeo.map((x) => x.slug),
    );
    expect(r[0]?.agent.slug).toBe("ceo");
  });
});

describe("isTaskKey", () => {
  test("matches T-<digits> in any case, nothing else", () => {
    expect(isTaskKey("T-42")).toBe(true);
    expect(isTaskKey("t-7")).toBe(true);
    expect(isTaskKey("t-")).toBe(false);
    expect(isTaskKey("t-4a")).toBe(false);
    expect(isTaskKey(" t-4")).toBe(false);
  });
});

describe("static lists", () => {
  test("Go to has unique ids and covers the spec's destinations", () => {
    const ids = GO_TO.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const to of [
      "/inbox",
      "/agents",
      "/tasks",
      "/templates",
      "/schedules",
      "/usage",
      "/settings/credentials",
      "/settings/secrets",
      "/settings/projects",
      "/settings/users",
      "/settings/factory",
    ]) {
      expect(GO_TO.some((g) => g.to === to)).toBe(true);
    }
    expect(GO_TO.some((g) => g.label === "Images")).toBe(true);
  });

  test("Actions never offer Mark all read", () => {
    expect(ACTIONS.length).toBeGreaterThan(0);
    expect(ACTIONS.some((x) => /mark all read/i.test(x.label))).toBe(false);
    for (const label of ["New agent", "New task", "New schedule", "Keyboard shortcuts"]) {
      expect(ACTIONS.some((x) => x.label === label)).toBe(true);
    }
  });
});
