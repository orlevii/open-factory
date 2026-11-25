import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { installInputModality } from "@/lib/input-modality";
import { json, mockApi } from "@/test/mock-api";
import { agentSummary } from "@/test/session-fixtures";
import { AgentCombobox } from "./agent-combobox";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => {
  off();
  vi.unstubAllGlobals();
});

const many = Array.from({ length: 214 }, (_, i) =>
  agentSummary({
    slug: `dev-${String(i).padStart(3, "0")}`,
    displayName: i === 42 ? "Zelda Quinn" : `Builder ${String(i).padStart(3, "0")}`,
  }),
);
const ended = agentSummary({
  slug: "old-one",
  displayName: "Old One",
  terminatedAt: "2026-11-01T00:00:00Z",
});
const archived = agentSummary({
  slug: "shelved",
  displayName: "Shelved",
  archivedAt: "2026-11-01T00:00:00Z",
});

function world(live = many) {
  return mockApi({
    "GET /api/agents?ended=exclude": () =>
      json({ agents: [...live, archived], more: false, running: { count: 0, max: 8 } }),
    "GET /api/agents?ended=only": () =>
      json({ agents: [ended], more: false, running: { count: 0, max: 8 } }),
  });
}

function Harness(
  props: Partial<React.ComponentProps<typeof AgentCombobox>> & { start?: string | null },
) {
  const [value, setValue] = useState<string | null>(props.start ?? null);
  const { start: _start, ...rest } = props;
  return (
    <AgentCombobox
      aria-label="Agent"
      scope="live"
      {...rest}
      value={value}
      onValueChange={(v) => {
        setValue(v);
        props.onValueChange?.(v);
      }}
    />
  );
}

function setup(props: Parameters<typeof Harness>[0] = {}) {
  const onValueChange = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Harness {...props} onValueChange={onValueChange} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onValueChange, trigger: screen.getByRole("combobox", { name: "Agent" }) };
}

const names = () =>
  screen.getAllByRole("option").map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim());

test("typing a slug or a name finds the agent among 214", async () => {
  world();
  const { trigger, onValueChange } = setup();
  await userEvent.click(trigger);
  await screen.findByRole("option", { name: /Builder 000/ });
  await userEvent.type(screen.getByRole("combobox", { name: "Search" }), "dev-042");
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeLessThan(5));
  expect(screen.getByRole("option", { name: /Zelda Quinn/ })).toBeInTheDocument();
  await userEvent.clear(screen.getByRole("combobox", { name: "Search" }));
  await userEvent.type(screen.getByRole("combobox", { name: "Search" }), "zelda");
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
  await userEvent.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenCalledWith("dev-042");
});

test("scope 'live' lists live agents only: no archived, no ended, and never fetches the ended list", async () => {
  const api = world();
  const { trigger } = setup();
  await userEvent.click(trigger);
  await screen.findByRole("option", { name: /Builder 000/ });
  expect(screen.queryByRole("option", { name: /Shelved/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /Old One/ })).toBeNull();
  expect(api.calls.some((c) => c.url.includes("ended=only"))).toBe(false);
});

test("arrow keys only move the highlight; nothing commits until Enter", async () => {
  world([
    agentSummary({ slug: "a", displayName: "A" }),
    agentSummary({ slug: "b", displayName: "B" }),
  ]);
  const { trigger, onValueChange } = setup();
  await userEvent.click(trigger);
  await screen.findByRole("option", { name: /^A/ });
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
  expect(onValueChange).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onValueChange).toHaveBeenCalledTimes(1);
});

test("fixed options stay first and commit null for the empty value", async () => {
  world([agentSummary({ slug: "a", displayName: "A" })]);
  const { trigger, onValueChange } = setup({
    start: "a",
    fixed: [{ value: "", label: "Unassigned", fixed: true }],
  });
  await waitFor(() => expect(trigger).toHaveTextContent("@a"));
  await userEvent.click(trigger);
  await screen.findByRole("option", { name: /^A/ });
  expect(names()[0]).toBe("Unassigned");
  await userEvent.click(screen.getByRole("option", { name: "Unassigned" }));
  expect(onValueChange).toHaveBeenCalledWith(null);
});

test("an unknown value renders @slug with a face", async () => {
  world();
  const { trigger } = setup({ start: "ghost" });
  expect(trigger).toHaveTextContent("@ghost");
  expect(trigger.querySelector("[data-agent-avatar]")).not.toBeNull();
});

test("a null value shows the placeholder", async () => {
  world();
  const { trigger } = setup({ placeholder: "Choose an agent…" });
  expect(trigger).toHaveTextContent("Choose an agent…");
});

test("filter narrows the options", async () => {
  world();
  const { trigger } = setup({ filter: (a) => a.slug === "dev-001" });
  await userEvent.click(trigger);
  await screen.findByRole("option", { name: /Builder 001/ });
  expect(screen.getAllByRole("option")).toHaveLength(1);
});

test("'live+ended' lists ended agents last under Ended, and a chosen ended agent shows on the trigger", async () => {
  world([agentSummary({ slug: "a", displayName: "A" })]);
  const { trigger } = setup({ scope: "live+ended", start: "old-one" });
  await userEvent.click(trigger);
  const listbox = await screen.findByRole("listbox");
  await within(listbox).findByRole("option", { name: /Old One/ });
  const groups = [...listbox.querySelectorAll("[cmdk-group]")].filter((g) =>
    g.querySelector("[cmdk-group-heading]"),
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]).toHaveTextContent("Ended");
  expect(
    within(groups[0] as HTMLElement).getByRole("option", { name: /Old One/ }),
  ).toBeInTheDocument();
  // The live agent comes first even though the ended one is the current value.
  expect(names()[0]).toMatch(/^A/);
  await userEvent.keyboard("{Escape}");
  expect(trigger).toHaveTextContent("Old One");
});
