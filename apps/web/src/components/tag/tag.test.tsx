import type { PrincipalItem } from "@open-factory/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Markdown } from "@/components/markdown/markdown";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createQueryClient } from "@/lib/query-client";
import { json, mockApi } from "@/test/mock-api";

const principal = (p: Partial<PrincipalItem> & Pick<PrincipalItem, "ref" | "handle">) =>
  ({
    id: `id-${p.ref}`,
    kind: "agent",
    name: p.handle,
    state: "live",
    avatar: { template: "dev", avatarVersion: null, color: null },
    ...p,
  }) satisfies PrincipalItem;

const DEV = principal({ ref: "k7x2m9qd", handle: "dev", name: "Dev Agent" });
const OLD = principal({
  ref: "n4n4n4n4",
  handle: "old-dev",
  name: "Ada Lovelace",
  state: "terminated",
});
const SAM = principal({
  ref: "s5s5s5s5",
  handle: "sam",
  name: "Sam Lee",
  kind: "human",
  avatar: null,
});
const ONLY = (ps: PrincipalItem[]) => json({ principals: ps });

let frames: FrameRequestCallback[];
const runFrame = () =>
  act(() => {
    for (const f of frames.splice(0)) f(0);
  });
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
});
afterEach(() => vi.unstubAllGlobals());

function setup(everyone: PrincipalItem[], late: PrincipalItem[] = []) {
  mockApi({
    "GET /api/principals": () => ONLY(everyone),
    "GET /api/principals?": (_b, url) => {
      const refs = new URL(url, "http://x").searchParams.get("refs")?.split(",") ?? [];
      return ONLY([...everyone, ...late].filter((p) => refs.includes(p.ref)));
    },
  });
}

async function renderMd(ui: ReactNode) {
  const qc = createQueryClient({ queries: { retry: false } });
  const root = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <TooltipProvider>{ui}</TooltipProvider>
      </QueryClientProvider>
    ),
  });
  const chat = createRoute({
    getParentRoute: () => root,
    path: "/agents/$slug/chat",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([chat]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const utils = render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  return utils;
}

test("a tag renders as a link to the agent's chat named by its current handle", async () => {
  setup([DEV]);
  await renderMd(<Markdown source={`Ask <@${DEV.ref}|stale-handle> please`} />);
  const link = await screen.findByRole("link", { name: "@dev, Dev Agent" });
  expect(link).toHaveAttribute("href", "/agents/dev/chat");
  expect(screen.queryByText(/stale-handle/)).toBeNull();
});

test("a human tag is not a link", async () => {
  setup([SAM]);
  await renderMd(<Markdown source={`cc <@${SAM.ref}>`} />);
  expect(await screen.findByText("@sam")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText(", Sam Lee")).toBeInTheDocument();
});

test("a terminated agent's chip says terminated to a screen reader", async () => {
  setup([OLD]);
  await renderMd(<Markdown source={`<@${OLD.ref}>`} />);
  expect(
    await screen.findByRole("link", { name: "@old-dev, Ada Lovelace, terminated" }),
  ).toBeInTheDocument();
});

test("a tag inside a code span renders as text", async () => {
  setup([DEV]);
  const { container } = await renderMd(<Markdown source={`Write \`<@${DEV.ref}>\` literally`} />);
  expect(container.querySelector("code")).toHaveTextContent(`<@${DEV.ref}>`);
  expect(screen.queryByRole("link")).toBeNull();
});

test("text that looks like a tag but isn't a ref stays text", async () => {
  setup([DEV]);
  // The first three characters of "uuuuuuuu" aren't in the ref alphabet.
  await renderMd(<Markdown source={"see <@uuuuuuuu> here"} />);
  expect(screen.getByText(/see <@uuuuuuuu> here/)).toBeInTheDocument();
});

test("a ref missing from the cache shows @… then the handle, never @unknown", async () => {
  setup([SAM], [DEV]);
  await renderMd(<Markdown source={`<@${DEV.ref}>`} />);
  expect(await screen.findByText("@…")).toBeInTheDocument();
  expect(screen.queryByText("@unknown")).toBeNull();
  await runFrame();
  expect(await screen.findByRole("link", { name: "@dev, Dev Agent" })).toBeInTheDocument();
  expect(screen.queryByText("@…")).toBeNull();
});

test("a ref nobody has reads @unknown and says so to a screen reader", async () => {
  setup([SAM]);
  await renderMd(<Markdown source={`<@${DEV.ref}>`} />);
  await waitFor(() => expect(frames.length).toBeGreaterThan(0));
  await runFrame();
  expect(await screen.findByText("@unknown")).toBeInTheDocument();
  expect(screen.getByText(", No one in this factory has this tag")).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
});

test("a tag inside a link renders as plain text, not a nested link", async () => {
  setup([DEV]);
  await renderMd(<Markdown source={`[open <@${DEV.ref}> now](/inbox)`} />);
  const outer = await screen.findByRole("link", { name: /open @dev/ });
  expect(within(outer).queryByRole("link")).toBeNull();
  expect(outer.querySelector("a")).toBeNull();
});

test("a tool output shows a tag as raw text", async () => {
  setup([DEV]);
  await renderMd(<Markdown source={`result <@${DEV.ref}>`} tags={false} untrusted />);
  expect(screen.getByText(`result <@${DEV.ref}>`)).toBeInTheDocument();
  expect(screen.queryByRole("link")).toBeNull();
});

test("an untrusted body (a schedule's message) still shows tags as chips", async () => {
  setup([DEV]);
  await renderMd(<Markdown source={`ping <@${DEV.ref}>`} untrusted variant="detail" />);
  expect(await screen.findByRole("link", { name: "@dev, Dev Agent" })).toBeInTheDocument();
});

test("copying a message with a chip puts @handle in text/plain and the tag in text/html", async () => {
  setup([DEV]);
  const { container } = await renderMd(<Markdown source={`Ask <@${DEV.ref}> now`} />);
  await screen.findByRole("link", { name: "@dev, Dev Agent" });
  const prose = container.querySelector("p") as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(prose);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
  const setData = vi.fn();
  const ev = new Event("copy", { bubbles: true, cancelable: true });
  Object.assign(ev, { clipboardData: { setData } });
  act(() => {
    prose.dispatchEvent(ev);
  });
  expect(ev.defaultPrevented).toBe(true);
  const data = Object.fromEntries(setData.mock.calls);
  expect(data["text/plain"]).toBe("Ask @dev now");
  expect(data["text/html"]).toBe(`Ask <span data-of-tag="${DEV.ref}">@dev</span> now`);
});

test("copying text with no chip leaves the browser's own copy alone", async () => {
  setup([DEV]);
  const { container } = await renderMd(<Markdown source={"plain words"} />);
  const prose = container.querySelector("p") as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(prose);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
  const setData = vi.fn();
  const ev = new Event("copy", { bubbles: true, cancelable: true });
  Object.assign(ev, { clipboardData: { setData } });
  fireEvent(prose, ev);
  expect(ev.defaultPrevented).toBe(false);
  expect(setData).not.toHaveBeenCalled();
});
