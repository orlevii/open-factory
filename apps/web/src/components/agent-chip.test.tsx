import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { agentSummary } from "@/test/session-fixtures";
import { AgentChip, PrincipalChip } from "./agent-chip";

const lead = agentSummary({ slug: "lead", displayName: "Team Lead" });

function wrap(ui: ReactNode, seed?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

test("agent form shows avatar, name and @slug; no native title", () => {
  const { container } = wrap(<AgentChip agent={lead} showSlug />);
  expect(screen.getAllByText("Team Lead").length).toBeGreaterThan(0);
  expect(screen.getAllByText("@lead").length).toBeGreaterThan(0);
  expect(container.querySelector("svg")).not.toBeNull();
  expect(container.querySelector("[title]")).toBeNull();
});

test("slug form resolves from the live list cache", () => {
  wrap(<AgentChip slug="lead" />, (qc) => qc.setQueryData(["agents", "exclude"], [lead]));
  expect(screen.getByText("Team Lead")).toBeInTheDocument();
});

test("slug form resolves an ended agent from the cache, never fetching it", () => {
  const gone = agentSummary({ slug: "gone", displayName: "Gone Bot" });
  wrap(<AgentChip slug="gone" />, (qc) => {
    qc.setQueryData(["agents", "exclude"], [lead]);
    qc.setQueryData(["agents", "only"], [gone]);
  });
  expect(screen.getByText("Gone Bot")).toBeInTheDocument();
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
