import type { PrincipalItem } from "@open-factory/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createQueryClient } from "@/lib/query-client";
import { json, mockApi } from "@/test/mock-api";
import { formatBy } from "./format-by";
import { quietText } from "./timeline-row";

test("a tag names its principal by ref, whatever handle it was written with", () => {
  expect(formatBy("<@k7x2m9qd>")).toEqual({ kind: "tag", ref: "k7x2m9qd" });
});

test("@factory is the inactivity TTL, never shown as a handle", () => {
  expect(formatBy("@factory")).toEqual({ kind: "ttl" });
});

test("a restart by a human shows their current handle", async () => {
  const ada: PrincipalItem = {
    id: "u-ada",
    ref: "a1d2a3d4",
    kind: "human",
    handle: "ada-renamed",
    name: "Ada Lovelace",
    state: "live",
    avatar: null,
  };
  mockApi({ "GET /api/principals": () => json({ principals: [ada] }) });
  const qc = createQueryClient({ queries: { retry: false } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <p>{quietText({ type: "control", cmd: "restart", by: "<@a1d2a3d4>" }, false)}</p>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(container.textContent).toContain("@ada-renamed"));
  expect(container.textContent).toContain("Restarted by");
});
