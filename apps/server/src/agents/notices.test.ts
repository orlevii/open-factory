import { expect, test } from "vitest";
import { notices, parseConfigNotice, renderConfigNotice } from "./notices.ts";

test("notice texts are literal and omit empty lists", () => {
  expect(
    notices.crash({
      exit: { code: 137, signal: null },
      duringTurn: true,
      tasks: ["pnpm test"],
      crons: [],
    }),
  ).toBe(
    "Your previous process stopped unexpectedly (exit code 137) during a turn. These background tasks were stopped: `pnpm test`. Check the state of that work and continue where you left off.",
  );
  expect(
    notices.crash({
      exit: { code: null, signal: "SIGKILL" },
      duringTurn: false,
      tasks: [],
      crons: ["every 5 minutes"],
    }),
  ).toBe(
    "Your previous process stopped unexpectedly (signal SIGKILL). These crons were stopped: every 5 minutes. Check the state of that work and continue where you left off.",
  );
  expect(notices.rateLimitReset({ credential: "work" })).toBe(
    "The rate limit on credential `work` reset. Continue where you left off.",
  );
});

test("the other notices", () => {
  expect(notices.factoryRestarted({ tasks: [] })).toBe(
    "The factory restarted while you were working. Check the state of that work and continue where you left off.",
  );
  expect(notices.factoryRestarted({ tasks: ["a", "b"] })).toContain("`a`, `b`.");
  expect(notices.restart({ by: "@or", tasks: [], crons: [] })).toBe(
    "Restarted by @or after an error.",
  );
  expect(notices.restart({ by: "@or", tasks: ["x"], crons: ["daily"] })).toBe(
    "Restarted by @or after an error. These background tasks were stopped: `x`. These crons were stopped: daily.",
  );
  expect(notices.restartCrons({ crons: ["every 5 minutes"] })).toBe(
    "Your session was restarted to apply configuration changes. These crons were stopped: every 5 minutes. Recreate them if you still need them.",
  );
  expect(notices.rateLimitReset({ credential: "work", at: new Date(2026, 0, 1, 14, 30) })).toBe(
    "The rate limit on credential `work` reset at 14:30. Continue where you left off.",
  );
});

test("the config_changed notice: a fixed header, one sorted line per change, parsed back", () => {
  const body = notices.configChanged([
    "model: sonnet → opus",
    "added skill release",
    "model: sonnet → opus",
  ]);
  expect(body).toBe("Your configuration changed:\n- added skill release\n- model: sonnet → opus");
  expect(parseConfigNotice(body)).toEqual(["added skill release", "model: sonnet → opus"]);
  // Merging is parse, union, render: the same lines twice give the same body.
  const merged = renderConfigNotice([
    ...parseConfigNotice(body),
    ...parseConfigNotice(renderConfigNotice(["env LOG_LEVEL changed", "added skill release"])),
  ]);
  expect(merged).toBe(
    "Your configuration changed:\n- added skill release\n- env LOG_LEVEL changed\n- model: sonnet → opus",
  );
  // A line break inside a line can't forge a second line, and empty lines are dropped.
  expect(parseConfigNotice(renderConfigNotice(["a\n- b", "  "]))).toEqual(["a - b"]);
  expect(renderConfigNotice([])).toBe("Your configuration changed:");
});

test("reportConfigChanged names the actor and the report, then one sorted line each, and reads back", () => {
  const body = notices.reportConfigChanged({
    by: "@hr",
    report: "dev",
    lines: ["added skill tdd", "model: sonnet → haiku", "added skill tdd"],
  });
  expect(body).toBe(
    "@hr changed @dev's configuration:\n- added skill tdd\n- model: sonnet → haiku",
  );
  expect(parseConfigNotice(body)).toEqual(["added skill tdd", "model: sonnet → haiku"]);
});
