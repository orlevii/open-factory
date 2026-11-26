import { expect, test } from "vitest";
import { matchSession } from "@/components/app-sidebar";
import { agentPageOf } from "@/features/palette/command-palette";
import { safeDecode } from "./safe-decode";

test("decodes a valid escape", () => {
  expect(safeDecode("dev%20ops")).toBe("dev ops");
});

test("returns a malformed escape unchanged instead of throwing", () => {
  expect(safeDecode("%zz")).toBe("%zz");
});

test("the palette and the sidebar read a malformed agent path without throwing", () => {
  expect(agentPageOf("/agents/%zz/chat")).toEqual({ agentRef: "%zz", view: "chat" });
  expect(matchSession("/agents/%zz/chat")).toBe("%zz");
  expect(agentPageOf("/agents/dev%20x/session")).toEqual({ agentRef: "dev x", view: "session" });
});
