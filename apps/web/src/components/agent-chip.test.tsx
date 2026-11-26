import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { refFor } from "@/test/refs";
import { agentSummary } from "@/test/session-fixtures";
import { AgentChip, PrincipalChip, TruncTooltip } from "./agent-chip";

const lead = agentSummary({ handle: "lead", displayName: "Team Lead" });

function wrapQc(ui: ReactNode, seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>{ui}</TooltipProvider>
      </QueryClientProvider>,
    ),
  };
}
const wrap = (ui: ReactNode, seed?: (qc: QueryClient) => void) => wrapQc(ui, seed);

test("agent form shows avatar, name and @handle; no native title", () => {
  const { container } = wrap(<AgentChip agent={lead} showHandle />);
  expect(screen.getAllByText("Team Lead")).toHaveLength(1);
  // Visible as a middle-truncatable head and tail, whole for screen readers.
  expect(screen.getAllByText("@lead")).toHaveLength(1);
  expect(screen.getByText("@le")).toBeInTheDocument();
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector("[title]")).toBeNull();
});

test("ref form resolves from the live list cache", () => {
  wrap(<AgentChip agentRef={refFor("lead")} />, (qc) =>
    qc.setQueryData(["agents", "exclude"], [lead]),
  );
  expect(screen.getByText("Team Lead")).toBeInTheDocument();
});

afterEach(() => vi.restoreAllMocks());

test("ref form resolves an ended agent from the cache", () => {
  const gone = agentSummary({ handle: "gone", displayName: "Gone Bot" });
  wrap(<AgentChip agentRef={refFor("gone")} />, (qc) => {
    qc.setQueryData(["agents", "exclude"], [lead]);
    qc.setQueryData(["agents", "only"], [gone]);
  });
  expect(screen.getByText("Gone Bot")).toBeInTheDocument();
});

test("a chip never fetches the ended list", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const { qc } = wrapQc(<AgentChip agentRef={refFor("gone")} />, (c) =>
    c.setQueryData(["agents", "exclude"], [lead]),
  );
  await Promise.resolve();
  expect(qc.isFetching({ queryKey: ["agents", "only"] })).toBe(0);
  expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/api/agents"))).toBe(false);
});

test("a chip mounting over a stale live list does not refetch it", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const { qc } = wrapQc(<AgentChip agentRef={refFor("lead")} />, (c) =>
    c.setQueryData(["agents", "exclude"], [lead]),
  );
  await Promise.resolve();
  expect(qc.isFetching()).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("ref form falls back to the principals cache's handle when no list has it", () => {
  const ghost = {
    id: "g1",
    ref: refFor("ghost"),
    kind: "agent" as const,
    handle: "ghost",
    name: "Ghost",
    state: "live" as const,
    avatar: null,
  };
  wrap(<AgentChip agentRef={refFor("ghost")} showHandle />, (qc) => {
    qc.setQueryData(["agents", "exclude"], [lead]);
    qc.setQueryData(["principals"], { byRef: new Map([[ghost.ref, ghost]]), unknown: new Set() });
  });
  expect(screen.getByText("Ghost")).toBeInTheDocument();
  expect(screen.getAllByText("@ghost").length).toBeGreaterThan(0);
});

test("a human principal renders the handle without an avatar", () => {
  const { container } = wrap(
    <PrincipalChip principal={{ kind: "human", ref: refFor("or"), handle: "or" }} />,
  );
  expect(screen.getByText("@or")).toBeInTheDocument();
  expect(container.querySelector("svg")).toBeNull();
});

test("tooltip only when truncated", async () => {
  wrap(<AgentChip agent={lead} />);
  const wrapper = screen.getByText("Team Lead").closest("span.flex") as HTMLElement;
  // equal widths: nothing opens
  await userEvent.hover(wrapper);
  expect(screen.queryByRole("tooltip")).toBeNull();
  await userEvent.unhover(wrapper);
  // truncated: opens with the full name
  Object.defineProperty(screen.getByText("Team Lead"), "scrollWidth", {
    configurable: true,
    value: 200,
  });
  Object.defineProperty(screen.getByText("Team Lead"), "clientWidth", {
    configurable: true,
    value: 50,
  });
  await userEvent.hover(wrapper);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Team Lead");
});

test("a click on a truncated name inside a link still follows the link", async () => {
  const follow = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  wrap(
    <a href={`/agents/${refFor("lead")}`} onClick={follow}>
      <TruncTooltip text="Team Lead">
        <span>Team Lead</span>
      </TruncTooltip>
    </a>,
  );
  const name = screen.getByText("Team Lead");
  Object.defineProperty(name, "scrollWidth", { configurable: true, value: 200 });
  Object.defineProperty(name, "clientWidth", { configurable: true, value: 50 });
  await userEvent.hover(name);
  await screen.findByRole("tooltip");
  // Radix closes on pointer down; the trigger must survive it so the click reaches the link.
  await userEvent.click(screen.getByText("Team Lead", { selector: "span:not([role])" }));
  expect(follow).toHaveBeenCalledTimes(1);
});

test("with the handle shown, the name's tooltip carries it too (kept when the handle hides)", async () => {
  wrap(<AgentChip agent={lead} showHandle />);
  // jsdom lays nothing out, so the handle reads as hidden: the name's tooltip arms.
  await userEvent.hover(screen.getByText("Team Lead").closest("span.flex") as HTMLElement);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Team Lead @lead");
});
