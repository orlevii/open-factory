import { expect, test } from "vitest";
import { notices } from "./notices.ts";

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
  expect(notices.restart({ by: "or", tasks: [], crons: [] })).toBe(
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
