import type { AgentSummary } from "@open-factory/shared";
import { describe, expect, test } from "vitest";
import { GO_TO, isTaskKey, rankAgents } from "./rank";

const a = (slug: string, displayName = slug): AgentSummary =>
  ({ slug, displayName }) as unknown as AgentSummary;
const slugs = (r: { agent: AgentSummary }[]) => r.map((x) => x.agent.slug);

describe("rankAgents", () => {
  test("marks exact, prefix and recent matches strong, substring matches not", () => {
    const r = rankAgents(
      "bot",
      [a("bot"), a("botany"), a("recent-bot"), a("xbotx")],
      [a("bot-old")],
      ["recent-bot"],
      [],
    );
    expect(r.map((x) => [x.agent.slug, x.strong])).toEqual([
      ["bot", true],
      ["botany", true],
      ["recent-bot", true],
      ["xbotx", false],
      ["bot-old", true],
    ]);
    expect(rankAgents("", [a("bot")], [], ["bot"], []).every((x) => x.strong)).toBe(true);
  });
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

describe("GO_TO", () => {
  test("has unique ids that open the expected paths", () => {
    const ids = GO_TO.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.fromEntries(GO_TO.map((g) => [g.id, g.to]))).toEqual({
      inbox: "/inbox",
      agents: "/agents",
      tasks: "/tasks",
      templates: "/templates",
      skills: "/skills",
      schedules: "/schedules",
      usage: "/usage",
      "settings-credentials": "/settings/credentials",
      "settings-secrets": "/settings/secrets",
      "settings-projects": "/settings/projects",
      "settings-users": "/settings/users",
      "settings-factory": "/settings/factory",
    });
  });
});
