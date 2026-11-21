import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { agentSummary } from "@/test/session-fixtures";
import { AgentChip, PrincipalChip } from "./agent-chip";

const lead = agentSummary({ slug: "lead", displayName: "Team Lead" });

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

test("agent form shows avatar, name and @slug; no native title", () => {
  const { container } = wrap(<AgentChip agent={lead} showSlug />);
  expect(screen.getAllByText("Team Lead")).toHaveLength(1);
  expect(screen.getAllByText("@lead")).toHaveLength(2); // visible + sr-only
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector("[title]")).toBeNull();
});

test("slug form resolves from the live list cache", () => {
  wrap(<AgentChip slug="lead" />, (qc) => qc.setQueryData(["agents", "exclude"], [lead]));
  expect(screen.getByText("Team Lead")).toBeInTheDocument();
});

afterEach(() => vi.restoreAllMocks());

test("slug form resolves an ended agent from the cache", () => {
  const gone = agentSummary({ slug: "gone", displayName: "Gone Bot" });
  wrap(<AgentChip slug="gone" />, (qc) => {
    qc.setQueryData(["agents", "exclude"], [lead]);
    qc.setQueryData(["agents", "only"], [gone]);
  });
  expect(screen.getByText("Gone Bot")).toBeInTheDocument();
});

test("a chip never fetches the ended list", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const { qc } = wrapQc(<AgentChip slug="gone" />, (c) =>
    c.setQueryData(["agents", "exclude"], [lead]),
  );
  await Promise.resolve();
  expect(qc.isFetching({ queryKey: ["agents", "only"] })).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("a chip mounting over a stale live list does not refetch it", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const { qc } = wrapQc(<AgentChip slug="lead" />, (c) =>
    c.setQueryData(["agents", "exclude"], [lead]),
  );
  await Promise.resolve();
  expect(qc.isFetching()).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test("slug form falls back to @slug when unknown", () => {
  wrap(<AgentChip slug="ghost" showSlug />, (qc) => qc.setQueryData(["agents", "exclude"], [lead]));
  expect(screen.getByText("@ghost")).toBeInTheDocument();
});

test("a human principal renders the handle without an avatar", () => {
  const { container } = wrap(<PrincipalChip principal={{ kind: "user", handle: "or" }} />);
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
