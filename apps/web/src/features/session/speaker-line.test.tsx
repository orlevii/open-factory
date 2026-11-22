import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, useContext } from "react";
import { expect, test } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
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
const dev = { slug: "dev", displayName: "Developer", template: "dev", kind: "persistent" as const };
const index = buildSpeakerIndex({
  sessionAgent: { ...dev, avatarVersion: null },
  selfHandle: "alice",
  live: [
    { slug: "b", displayName: "Builder", template: "dev", kind: "persistent", avatarVersion: null },
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

test("an agent sender: a 20px avatar, the name, a muted @slug, a time that never shrinks; a link to its session", async () => {
  await show(<SpeakerLine from="b" at={AT} />);
  const l = line();
  const link = within(l).getByRole("link");
  expect(link).toHaveAttribute("href", "/agents/b");
  expect(link).toHaveTextContent("Builder");
  const avatar = l.querySelector<HTMLElement>("[style*='width: 20px']");
  expect(avatar).not.toBeNull();
  expect(within(l).getByText("Builder").closest("[dir=auto]")).not.toBeNull();
  const slug = within(l).getAllByText("@b")[0]?.closest(".font-mono") as HTMLElement;
  expect(slug).toHaveClass("text-muted-foreground");
  expect(
    within(l)
      .getByText(/^\d\d:\d\d$/)
      .closest("time"),
  ).toHaveClass("shrink-0");
});

test("at a 20rem container the handle hides: the line is a container and the slug carries the query", async () => {
  await show(<SpeakerLine from="b" at={AT} />);
  expect(line()).toHaveClass("@container");
  const slug = within(line()).getAllByText("@b")[0]?.closest(".font-mono") as HTMLElement;
  expect(slug.className).toMatch(/@max-\[20rem\]:hidden/);
});

test("the session's own agent is never a link", async () => {
  await show(<SpeakerLine from="dev" at={AT} self />);
  expect(within(line()).queryByRole("link")).toBeNull();
  expect(within(line()).getByText("Developer")).toBeInTheDocument();
});

test("your own message says 'You', with no second fill", async () => {
  await show(<SpeakerLine from="@alice" at={AT} />);
  const l = line();
  expect(within(l).getByText("You")).toHaveAttribute("dir", "auto");
  expect(within(l).queryByText("@alice")).toBeNull();
  expect(l.className).not.toMatch(/\bbg-/);
  for (const el of l.querySelectorAll("*")) expect(el.className.toString()).not.toMatch(/\bbg-/);
});

test("a human: the name from the users list and the muted handle, no avatar; else the handle", async () => {
  await show(
    <>
      <SpeakerLine from="@or" at={AT} />
      <SpeakerLine from="@stranger" at={AT} />
    </>,
  );
  const [known, unknown] = [...document.querySelectorAll<HTMLElement>("[data-speaker-line]")];
  expect(within(known as HTMLElement).getByText("Or Levi")).toHaveAttribute("dir", "auto");
  expect(within(known as HTMLElement).getAllByText("@or").length).toBeGreaterThan(0);
  expect(known?.querySelector("svg,img")).toBeNull();
  expect(within(unknown as HTMLElement).getByText("@stranger")).toHaveClass("font-mono");
});

test("an outgoing card reads 'Name → Recipient': You for you, All humans for @humans", async () => {
  await show(
    <>
      <SpeakerLine from="dev" self to="@alice" at={AT} />
      <SpeakerLine from="dev" self to="@humans" at={AT} />
      <SpeakerLine from="dev" self to="b" at={AT} />
    </>,
  );
  const lines = [...document.querySelectorAll<HTMLElement>("[data-speaker-line]")];
  const text = (el: HTMLElement | undefined) =>
    (el?.textContent ?? "").replace(/\s+/g, " ").replace(/\d\d:\d\d$/, "");
  expect(text(lines[0])).toMatch(/^Developer.*@dev.*You$/);
  expect(text(lines[1])).toMatch(/All humans$/);
  expect(within(lines[2] as HTMLElement).getByRole("link")).toHaveAttribute("href", "/agents/b");
});

test("outside a session the line still renders: a slug stands in for an unknown agent", () => {
  render(
    <TooltipProvider>
      <SpeakerLine from="@or" at={AT} />
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
  const b = agentSummary({ slug: "b", displayName: "Builder" });
  qc.setQueryData(["agents", "exclude"], [agentSummary(), b]);
  qc.setQueryData(["users"], []);
  seen.length = 0;
  render(
    <QueryClientProvider client={qc}>
      <SpeakerProvider
        slug="dev"
        displayName="Dev agent"
        template="dev"
        kind="persistent"
        avatarVersion={null}
        selfHandle="alice"
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
