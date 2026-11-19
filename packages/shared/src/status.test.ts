import { expect, test } from "vitest";
import type { AgentStatus } from "./agents.ts";
import { type StatusInputs, statusOf } from "./status.ts";

const base: StatusInputs = {
  terminated: false,
  errored: false,
  attempting: false,
  working: false,
  credentialPaused: false,
  hasPendingWork: false,
  queuedWake: false,
  processRunning: false,
};
test.each<[string, Partial<StatusInputs>, AgentStatus]>([
  ["nothing", {}, "hibernated"],
  ["warm", { processRunning: true }, "idle"],
  ["working", { processRunning: true, working: true }, "working"],
  ["queued", { queuedWake: true }, "queued"],
  ["paused + running", { credentialPaused: true, processRunning: true }, "rate_limited"],
  ["paused + queued", { credentialPaused: true, queuedWake: true }, "rate_limited"],
  [
    "paused + pending, hibernated",
    { credentialPaused: true, hasPendingWork: true },
    "rate_limited",
  ],
  ["paused, nothing pending, hibernated", { credentialPaused: true }, "hibernated"],
  ["errored", { errored: true }, "errored"],
  ["errored + paused", { errored: true, credentialPaused: true, queuedWake: true }, "errored"],
  ["attempt queued", { errored: true, attempting: true, queuedWake: true }, "queued"],
  [
    "attempt paused",
    { errored: true, attempting: true, credentialPaused: true, queuedWake: true },
    "rate_limited",
  ],
  [
    "attempt running between turns",
    { errored: true, attempting: true, processRunning: true },
    "working",
  ],
  [
    "attempt working",
    { errored: true, attempting: true, working: true, processRunning: true },
    "working",
  ],
])("%s", (_n, over, want) => {
  expect(statusOf({ ...base, ...over })).toBe(want);
});

test.each<[Partial<StatusInputs>, AgentStatus]>([
  [{ terminated: true, errored: true, attempting: false }, "terminated"],
  [{ terminated: true, working: true }, "terminated"],
  [{ terminated: false, errored: true, attempting: false }, "errored"],
])("terminated precedence %#", (partial, want) => {
  expect(statusOf({ ...base, ...partial })).toBe(want);
});
