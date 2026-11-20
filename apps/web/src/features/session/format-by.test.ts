import { expect, test } from "vitest";
import { formatBy } from "./format-by";

test("a bare slug is an agent (rendered as an AgentLink)", () => {
  expect(formatBy("lead")).toEqual({ kind: "agent", slug: "lead" });
});

test("a human @handle stays a handle (plain mono)", () => {
  expect(formatBy("@or")).toEqual({ kind: "human", handle: "@or" });
});

test("@factory is the inactivity TTL, never shown as a handle", () => {
  expect(formatBy("@factory")).toEqual({ kind: "ttl" });
});
