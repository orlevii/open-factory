import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useContext } from "react";
import { expect, test, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sessionQueryOptions } from "@/lib/session";
import { refFor } from "@/test/refs";
import { renderInRouter } from "@/test/render-in-router";
import { agentSummary } from "@/test/session-fixtures";
import {
  buildSpeakerIndex,
  SpeakerContext,
  type SpeakerIndex,
  SpeakerLine,
  SpeakerProvider,
} from "./speaker-line";

const AT = "2026-11-19T14:02:00.000Z";
const dev = {
  ref: refFor("dev"),
  handle: "dev",
  displayName: "Developer",
  template: "dev",
  kind: "persistent" as const,
};
const index = buildSpeakerIndex({
  sessionAgent: { ...dev, avatarVersion: null },
  selfHandle: "alice",
  live: [
    {
      ref: refFor("b"),
      handle: "b",
      displayName: "Builder",
      template: "dev",
      kind: "persistent",
      avatarVersion: null,
    },
  ],
  ended: [],
  users: [
    ["or", "Or Levi"],
    ["alice", "Alice"],
  ],
});

async function show(ui: ReactNode) {
  renderInRouter(
    <TooltipProvider>
      <SpeakerContext value={index}>{ui}</SpeakerContext>
    </TooltipProvider>,
  );
  await waitFor(() => expect(document.querySelector("[data-speaker-line]")).not.toBeNull());
}
const line = () => document.querySelector<HTMLElement>("[data-speaker-line]") as HTMLElement;

test("an agent sender: an avatar, the name, the @handle, a time; a link to its session", async () => {
  await show(<SpeakerLine from="b" fromKind="agent" at={AT} />);
  const l = line();
  const link = within(l).getByRole("link");
  expect(link).toHaveAttribute("href", `/agents/${refFor("b")}/chat`);
  expect(link).toHaveTextContent("Builder");
  const avatar = l.querySelector<HTMLElement>("[style*='width: 20px']");
  expect(avatar).not.toBeNull();
  expect(within(l).getByText("Builder").closest("[dir=auto]")).not.toBeNull();
  expect(within(l).getAllByText("@b").length).toBeGreaterThan(0);
  expect(
    within(l)
      .getByText(/^\d\d:\d\d$/)
      .closest("time"),
  ).not.toBeNull();
});

test("the session's own agent is never a link", async () => {
  await show(<SpeakerLine from="dev" fromKind="agent" at={AT} self />);
  expect(within(line()).queryByRole("link")).toBeNull();
  expect(within(line()).getByText("Developer")).toBeInTheDocument();
});

test("your own message says 'You', without the handle", async () => {
  await show(<SpeakerLine from="@alice" fromKind="human" at={AT} />);
  const l = line();
  expect(within(l).getByText("You")).toHaveAttribute("dir", "auto");
  expect(within(l).queryByText("@alice")).toBeNull();
  expect(l.querySelector("[data-human-avatar]")).toHaveTextContent("A");
});

test("a human: an initials avatar, the name from the users list and the muted handle; else a glyph and the handle", async () => {
  await show(
    <>
      <SpeakerLine from="@or" fromKind="human" at={AT} />
      <SpeakerLine from="@stranger" fromKind="human" at={AT} />
    </>,
  );
  const [known, unknown] = [...document.querySelectorAll<HTMLElement>("[data-speaker-line]")];
  expect(within(known as HTMLElement).getByText("Or Levi")).toHaveAttribute("dir", "auto");
  expect(within(known as HTMLElement).getAllByText("@or").length).toBeGreaterThan(0);
  expect(known?.querySelector("[data-human-avatar]")).toHaveTextContent("OL");
  expect(within(unknown as HTMLElement).getByText("@stranger")).toBeInTheDocument();
  expect(unknown?.querySelector("[data-human-avatar] svg")).not.toBeNull();
});

test("an outgoing card reads 'Name → Recipient': You for you, an agent as a link", async () => {
  await show(
    <>
      <SpeakerLine
        from="dev"
        fromKind="agent"
        self
        to={[{ handle: "@alice", kind: "human" }]}
        at={AT}
      />
      <SpeakerLine
        from="dev"
        fromKind="agent"
        self
        to={[{ handle: "@b", kind: "agent" }]}
        at={AT}
      />
    </>,
  );
  const lines = [...document.querySelectorAll<HTMLElement>("[data-speaker-line]")];
  const text = (el: HTMLElement | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").replace(/\d\d:\d\d$/, "");
  expect(text(lines[0])).toMatch(/^Developer.*@dev.*You$/);
  expect(within(lines[1] as HTMLElement).getByRole("link", { name: /Builder/ })).toHaveAttribute(
    "href",
    `/agents/${refFor("b")}/chat`,
  );
});

test("a sender's kind decides how it shows, whatever its sigil: an `@` agent is a chip, an unknown `@` handle plain", async () => {
  await show(
    <>
      <SpeakerLine from="@b" fromKind="agent" at={AT} />
      <SpeakerLine from="@b" fromKind="agent" at={AT} />
      <SpeakerLine from="@zed" fromKind="human" at={AT} />
    </>,
  );
  const [explicit, looked, human] = [
    ...document.querySelectorAll<HTMLElement>("[data-speaker-line]"),
  ] as HTMLElement[];
  expect(within(explicit as HTMLElement).getByRole("link")).toHaveAttribute(
    "href",
    `/agents/${refFor("b")}/chat`,
  );
  expect(within(looked as HTMLElement).getByRole("link")).toHaveAttribute(
    "href",
    `/agents/${refFor("b")}/chat`,
  );
  expect(within(human as HTMLElement).queryByRole("link")).toBeNull();
  expect(within(human as HTMLElement).getByText("@zed")).toBeInTheDocument();
});

const chip = (l: HTMLElement) => l.querySelector("[data-agent-avatar]");

test("an agent the server names by kind is a chip even before the lists load (no flip on first paint)", async () => {
  const requestEnded = vi.fn();
  await show(
    <SpeakerContext value={buildSpeakerIndex({ requestEnded })}>
      <SpeakerLine from="@gone-ab12" fromKind="agent" at={AT} />
    </SpeakerContext>,
  );
  expect(chip(line())).not.toBeNull();
  expect(requestEnded).not.toHaveBeenCalled();
});

test("an ended agent the server names by kind is a chip, and asks for the ended list once the live one is in", async () => {
  const requestEnded = vi.fn();
  await show(
    <SpeakerContext value={buildSpeakerIndex({ live: [], requestEnded })}>
      <SpeakerLine from="@gone-ab12" fromKind="agent" at={AT} />
    </SpeakerContext>,
  );
  expect(chip(line())).not.toBeNull();
  await waitFor(() => expect(requestEnded).toHaveBeenCalled());
});

test("a human the server names by kind never looks up agents", async () => {
  const requestEnded = vi.fn();
  await show(
    <SpeakerContext value={buildSpeakerIndex({ live: [], requestEnded })}>
      <SpeakerLine from="@gone-ab12" fromKind="human" at={AT} />
    </SpeakerContext>,
  );
  expect(chip(line())).toBeNull();
  expect(requestEnded).not.toHaveBeenCalled();
});

test("outside a session the line still renders: a handle stands in for an unknown agent", () => {
  render(
    <TooltipProvider>
      <SpeakerLine from="@or" fromKind="human" at={AT} />
    </TooltipProvider>,
  );
  expect(screen.getByText("@or")).toBeInTheDocument();
});

const seen: SpeakerIndex[] = [];
function Probe() {
  seen.push(useContext(SpeakerContext));
  return null;
}

test("the provider's index survives a status frame; a name change builds a new one (m7)", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const b = agentSummary({ handle: "b", displayName: "Builder" });
  qc.setQueryData(["agents", "exclude"], [agentSummary(), b]);
  qc.setQueryData(["users"], []);
  seen.length = 0;
  render(
    <QueryClientProvider client={qc}>
      <SpeakerProvider
        agentRef={refFor("dev")}
        displayName="Dev agent"
        template="dev"
        kind="persistent"
        avatarVersion={null}
      >
        <Probe />
      </SpeakerProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(seen.at(-1)?.agent("b").agent.displayName).toBe("Builder"));
  const before = seen.at(-1);
  const renders = seen.length;
  // Observers notify on the next tick: let it pass.
  const tick = () => act(() => new Promise((r) => setTimeout(r, 0)));
  qc.setQueryData(["agents", "exclude"], [agentSummary(), { ...b, status: "working" }]);
  await tick();
  expect(seen.length).toBe(renders); // nothing a speaker line shows changed: no render at all
  expect(seen.at(-1)).toBe(before);
  qc.setQueryData(["agents", "exclude"], [agentSummary(), { ...b, displayName: "Builder 2" }]);
  await tick();
  expect(seen.at(-1)).not.toBe(before);
  expect(seen.at(-1)?.agent("b").agent.displayName).toBe("Builder 2");
});

test("the provider reads your handle itself, and asks for the ended list only once the live list is in", async () => {
  const calls: string[] = [];
  let release: (r: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url);
      if (url === "/api/agents?ended=exclude")
        return new Promise<Response>((r) => {
          release = r;
        });
      return Promise.resolve(
        new Response(
          JSON.stringify({ agents: [], users: [], more: false, running: { count: 0 } }),
          {
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }),
  );
  try {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(sessionQueryOptions.queryKey, {
      user: { handle: "alice" },
    } as never);
    renderInRouter(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <SpeakerProvider agentRef={refFor("dev")}>
            <SpeakerLine from="gone" fromKind="agent" at={AT} />
            <SpeakerLine from="@alice" fromKind="human" at={AT} />
          </SpeakerProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("You")).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls).not.toContain("/api/agents?ended=only");
    release(
      new Response(JSON.stringify({ agents: [], running: { count: 0 } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await waitFor(() => expect(calls).toContain("/api/agents?ended=only"));
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a human's name carries the handle in its title (kept when the handle hides)", async () => {
  await show(<SpeakerLine from="@or" fromKind="human" at={AT} />);
  expect(within(line()).getByText("Or Levi")).toHaveAttribute("title", "Or Levi @or");
});

test("badges sit outside the names-and-time group, so a long badge wraps below instead of squeezing the names", async () => {
  await show(
    <SpeakerLine from="b" fromKind="agent" at={AT}>
      <span data-testid="badge">T-1 a very long task title</span>
    </SpeakerLine>,
  );
  const group = (line().querySelector("time") as HTMLElement).parentElement as HTMLElement;
  expect(group).not.toContainElement(screen.getByTestId("badge"));
  expect(screen.getByTestId("badge").parentElement).toBe(line());
});
