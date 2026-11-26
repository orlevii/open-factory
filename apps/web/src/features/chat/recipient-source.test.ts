import { QueryClient } from "@tanstack/react-query";
import { expect, test, vi } from "vitest";
import { agentsListQueryOptions } from "@/features/session/api";
import { refFor } from "@/test/refs";
import { agentSummary } from "@/test/session-fixtures";
import { FULL_NOTE, MENU_NOTE, recipientSource } from "./recipient-source";

function setup(added: string[], agents = ["dev", "ops", "qa", "old"]) {
  const qc = new QueryClient();
  qc.setQueryData(
    agentsListQueryOptions("exclude").queryKey,
    agents.map((handle) =>
      agentSummary({
        handle: handle,
        displayName: handle,
        ...(handle === "old" ? { archivedAt: "2026-11-01T00:00:00.000Z" } : {}),
      }),
    ),
  );
  const add = vi.fn((s: string) => {
    added.push(s);
    return true;
  });
  return { source: recipientSource(qc, { agentRef: refFor("dev"), added: () => added, add }), add };
}

test("offers live agents without the chat's agent and the added ones", () => {
  const { source } = setup([refFor("ops")]);
  expect(source.items("").map((i) => i.id)).toEqual([refFor("qa")]);
  expect(source.items("").map((i) => i.label)).toEqual(["Add @qa as recipient"]);
  expect(source.menuNote?.(1)).toBe(MENU_NOTE);
});

test("at ten recipients nothing is offered and the menu says so", () => {
  const added = Array.from({ length: 9 }, (_, i) => refFor(`a${i}`));
  const { source } = setup(added);
  expect(source.items("")).toEqual([]);
  expect(source.menuNote?.(0)).toBe(FULL_NOTE);
});

test("accepting adds the agent and removes the token; a refused add leaves the text", () => {
  const { source, add } = setup([]);
  const item = { id: "ops", label: "", group: "agents" };
  expect(source.accept(item, "hi @op there", 3, 6)).toEqual({ text: "hi there", caret: 3 });
  expect(add).toHaveBeenCalledWith("ops");
  add.mockReturnValueOnce(false);
  expect(source.accept(item, "hi @op", 3, 6)).toEqual({ text: "hi @op", caret: 6 });
});
