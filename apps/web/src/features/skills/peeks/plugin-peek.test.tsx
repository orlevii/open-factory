import type { ServerMessage } from "@open-factory/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createQueryClient } from "@/lib/query-client";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";
import { hostGroup, library, NO_CONTENTS, plugin, pluginGroup, pluginsResponse } from "../fixtures";
import { PluginPeekBody } from "./plugin-peek";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: (_o: { onMessage?: (m: ServerMessage) => void }) => ({
    close() {},
    status: () => "open",
    send: () => true,
  }),
}));
vi.mock("@/components/ui/toaster", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/toaster")>();
  return { ...actual, notify: vi.fn(actual.notify) };
});

beforeEach(() => fakeMatchMedia.install(false));
afterEach(() => vi.clearAllMocks());

const LIBRARY = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PIN = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

const contents = (o: Record<string, unknown> = {}) => ({
  manifest: {
    name: "review",
    version: "1.2.0",
    description: null,
    author: null,
    homepage: null,
    repository: null,
  },
  hooks: [],
  mcp: [],
  dependencies: [],
  codeParts: [],
  needs: [],
  provides: { skills: [], commands: [], agents: [], outputStyles: [] },
  unshown: [],
  files: [],
  summary: { ...NO_CONTENTS },
  ...o,
});

const detail = (o: Record<string, unknown> = {}) => ({
  key: "review@acme",
  name: "review",
  marketplace: "acme",
  from: "library",
  commit: LIBRARY,
  version: "1.2.0",
  description: "Reviews pull requests",
  pinnable: true,
  state: "ok",
  source: { kind: "relative", detail: "./plugins/review" },
  contents: contents(),
  contentsNote: null,
  canRead: false,
  hostVersion: null,
  usedBy: { templates: [], overlays: [] },
  ...o,
});

const hook = (command: string, o: Record<string, unknown> = {}) => ({
  event: "PreToolUse",
  matcher: "Bash",
  type: "command",
  command,
  timeout: null,
  ...o,
});

const baseList = (entry = plugin("review@acme", { version: "1.2.0" })) =>
  pluginsResponse([pluginGroup("acme", LIBRARY, [entry])]);

type Routes = Parameters<typeof mockApi>[0];
function serve(routes: Routes = {}, list: unknown = baseList()) {
  return mockApi({
    "GET /api/library/plugins": () => json(list),
    "GET /api/library/skills": () => json(library([hostGroup()])),
    "GET /api/library/marketplaces": () => json({ marketplaces: [] }),
    "GET /api/agents?": () => json({ agents: [], more: false, running: { count: 0, max: 8 } }),
    "GET /api/host": () => json({ platform: "linux", hostname: "box", home: "/home/me", sep: "/" }),
    ...routes,
  });
}

/** The peek, opened from its row on the Plugins view. */
async function open(routes: Routes = {}, list?: unknown, rowName: RegExp = /review/) {
  const mocks = serve(routes, list);
  const user = userEvent.setup();
  renderApp("/skills/plugins", alice);
  await user.click(await screen.findByRole("button", { name: rowName }));
  const dialog = await screen.findByRole("dialog");
  return { mocks, user, dialog: within(dialog) };
}

const sections = (d: Awaited<ReturnType<typeof open>>["dialog"]) =>
  d.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

test("Runs code comes first, then Needs from the image, with the program names and the note", async () => {
  const { dialog: d } = await open({
    "GET /api/library/plugins/review%40acme": () =>
      json(
        detail({
          contents: contents({
            hooks: [hook("./guard.sh")],
            needs: ["node", "uvx"],
            provides: { skills: ["review"], commands: [], agents: [], outputStyles: [] },
            summary: { ...NO_CONTENTS, hooks: 1, needs: 2, skills: 1 },
          }),
        }),
      ),
  });
  await d.findByText("./guard.sh");
  expect(sections(d).slice(0, 3)).toEqual(["Runs code", "Needs from the image", "Provides"]);
  expect(
    d.getByText((_, el) => el?.tagName === "P" && el.textContent === "node, uvx"),
  ).toBeInTheDocument();
  expect(
    d.getByText(
      "The agent's image (or this machine, for a local agent) must provide these. Open Factory doesn't install or test them.",
    ),
  ).toBeInTheDocument();
});

test("a plugin with no hooks or servers says it runs none", async () => {
  const { dialog: d } = await open({
    "GET /api/library/plugins/review%40acme": () => json(detail()),
  });
  expect(await d.findByText("Runs no hooks or servers.")).toBeInTheDocument();
});

test("while the detail loads the sections show Loading contents, and then the real hooks", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const list = baseList(
    plugin("review@acme", { contentsSummary: { ...NO_CONTENTS, hooks: 2, mcp: 1 } }),
  );
  const { dialog: d } = await open(
    {
      "GET /api/library/plugins/review%40acme": async () => {
        await gate;
        return json(
          detail({
            contents: contents({
              hooks: [hook("./late.sh")],
              summary: { ...NO_CONTENTS, hooks: 1 },
            }),
          }),
        );
      },
    },
    list,
  );
  expect(d.getByRole("status")).toHaveTextContent("Loading contents…");
  // The header already shows what the list knew: two hooks and a server.
  expect(d.getByText("2 hooks")).toBeInTheDocument();
  release();
  expect(await d.findByText("./late.sh")).toBeInTheDocument();
  expect(d.queryByText("Loading contents…")).not.toBeInTheDocument();
});

test("View file opens from the first line, flips to Hide file, and shows Cut at 256 KB when the server cut it", async () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const cut = `${"x".repeat(256 * 1024 - 1)}`;
  const { dialog: d, user } = await open({
    "GET /api/library/plugins/review%40acme": () =>
      json(detail({ contents: contents({ files: ["hooks/guard.sh", "big.txt"] }) })),
    "GET /api/library/plugins/review%40acme/file?": (_b, url) =>
      json({
        path: new URL(url, "http://x").searchParams.get("path"),
        text: url.includes("big.txt") ? cut : text,
      }),
  });
  const files = await d.findAllByRole("button", { name: "View file" });
  await user.click(files[0] as HTMLElement);
  expect(await d.findByText(/line 1\b/)).toBeInTheDocument();
  expect(d.queryByText(/line 60/)).not.toBeInTheDocument();
  expect(d.getByRole("button", { name: "Show all · 60 lines" })).toBeInTheDocument();
  const toggle = d.getByRole("button", { name: "Hide file" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(toggle).toHaveFocus();
  await user.click(d.getAllByRole("button", { name: "View file" })[0] as HTMLElement);
  expect(await d.findByText("Cut at 256 KB.")).toBeInTheDocument();
});

test("Used by shows each template's pin and the Latest badge's words, and links to the template", async () => {
  const { dialog: d } = await open({
    "GET /api/library/plugins/review%40acme": () =>
      json(
        detail({
          usedBy: {
            templates: [
              { name: "dev", pin: `commit:${PIN}`, agents: 2 },
              { name: "ops", pin: "latest", agents: 1 },
            ],
            overlays: [{ agent: "ana", template: "dev", pin: `commit:${PIN}` }],
          },
        }),
      ),
  });
  const used = (await d.findByRole("heading", { name: "Used by" })).closest(
    "section",
  ) as HTMLElement;
  const u = within(used);
  expect(u.getByRole("link", { name: "dev" })).toHaveAttribute("href", "/templates/dev");
  expect(u.getAllByText("pinned 9f8e7d6")).toHaveLength(2);
  expect(u.getByText("Latest")).toBeInTheDocument();
  expect(u.getByText("auto-updates")).toBeInTheDocument();
  expect(u.getByRole("link", { name: "@ana" })).toHaveAttribute("href", "/agents/ana");
});

test("an external source that isn't read offers Read contents, which reads it", async () => {
  let read = false;
  const {
    dialog: d,
    user,
    mocks,
  } = await open({
    "GET /api/library/plugins/review%40acme": () =>
      json(
        read
          ? detail({ contents: contents({ hooks: [hook("./now.sh")] }) })
          : detail({ contents: null, contentsNote: "Contents not read yet", canRead: true }),
      ),
    "POST /api/library/plugins/review%40acme/read": () => {
      read = true;
      return json(detail({ contents: contents({ hooks: [hook("./now.sh")] }) }));
    },
  });
  await user.click(await d.findByRole("button", { name: "Read contents" }));
  expect(await d.findByText("./now.sh")).toBeInTheDocument();
  expect(mocks.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("a host plugin offers only Add its marketplace, which registers it with an Undo", async () => {
  const hostList = pluginsResponse(
    [],
    [
      {
        key: "extra@elsewhere",
        name: "extra",
        marketplace: "elsewhere",
        version: "1.0.0",
        lastUpdated: null,
        contentsSummary: { ...NO_CONTENTS, skills: 1 },
      },
    ],
  );
  const added = {
    name: "elsewhere",
    source: { source: "github", repo: "acme/elsewhere" },
    branch: "main",
    commit: LIBRARY,
    committedAt: null,
    subject: null,
    tags: {},
    state: "ready",
    updateCommit: null,
    updateAt: null,
    updateSubject: null,
    checkedAt: null,
    checkError: null,
    usedBy: { templates: 0, agents: 0 },
    since: null,
    checking: null,
  };
  const {
    dialog: d,
    user,
    mocks,
  } = await open(
    {
      "GET /api/library/plugins/extra%40elsewhere?": () =>
        json(
          detail({
            key: "extra@elsewhere",
            name: "extra",
            marketplace: "elsewhere",
            from: "host",
            commit: null,
            pinnable: false,
            source: { kind: "host", detail: "Installed on this host" },
          }),
        ),
      "POST /api/library/host-plugins/extra%40elsewhere/add-marketplace": () => json(added, 201),
      "DELETE /api/library/marketplaces/elsewhere": () =>
        json({ undoUntil: new Date(Date.now() + 30_000).toISOString() }),
    },
    hostList,
    /extra/,
  );
  expect(
    d.getByText("Registers elsewhere from this host's record. Nothing is installed."),
  ).toBeInTheDocument();
  expect(
    d.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent),
  ).toContain("Add its marketplace");
  await user.click(d.getByRole("button", { name: "Add its marketplace" }));
  await waitFor(() =>
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Added elsewhere at a1b2c3d." }),
    ),
  );
  const toast = vi.mocked(notify).mock.calls.at(-1)?.[0];
  await toast?.undo?.();
  expect(mocks.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/elsewhere"))).toBe(true);
});

test("a host plugin whose marketplace record can't be used shows why, and Add its marketplace is refused", async () => {
  const {
    dialog: d,
    user,
    mocks,
  } = await open(
    {
      "GET /api/library/plugins/extra%40elsewhere?": () =>
        json(detail({ key: "extra@elsewhere", from: "host", commit: null })),
    },
    pluginsResponse(
      [],
      [
        {
          key: "extra@elsewhere",
          name: "extra",
          marketplace: "elsewhere",
          version: null,
          lastUpdated: null,
          contentsSummary: null,
          addRefusedReason: "The host's record for elsewhere can't be used: it has no source.",
        },
      ],
    ),
    /extra/,
  );
  expect(d.getByText(/can't be used: it has no source/)).toBeInTheDocument();
  await user.click(d.getByRole("button", { name: "Add its marketplace" }));
  expect(mocks.calls.filter((c) => c.method === "POST")).toHaveLength(0);
});

type HarnessProps = { readOnly?: boolean; commits: string[] };

/** The peek body alone, as the Configuration form mounts it: at a template's pin, optionally read-only. The button
 *  moves it to the next commit without remounting it. */
function Harness({ readOnly = false, commits }: HarnessProps) {
  const [i, setI] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setI((n) => n + 1)}>
        next commit
      </button>
      <Sheet open modal={false} onOpenChange={() => {}}>
        <SheetContent aria-describedby={undefined}>
          <PluginPeekBody
            pluginKey="review@acme"
            commit={commits[i]}
            readOnly={readOnly}
            back={null}
            onBack={() => {}}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}

function mount(props: HarnessProps) {
  const client = createQueryClient({ queries: { retry: false } });
  const root = createRootRoute();
  const stub = (path: string, component: () => ReactNode = () => null) =>
    createRoute({ getParentRoute: () => root, path, component });
  const router = createRouter({
    routeTree: root.addChildren([
      stub("/", () => <Harness {...props} />),
      stub("/skills/plugins"),
      stub("/templates/$name"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

test("the same plugin opened at two commits shows each commit's hooks, and At names a pin that isn't the Library's", async () => {
  serve({
    "GET /api/library/plugins/review%40acme?": (_b, url) =>
      json(
        url.includes(PIN)
          ? detail({ commit: PIN, contents: contents({ hooks: [hook("./old-guard.sh")] }) })
          : detail({ commit: LIBRARY, contents: contents({ hooks: [hook("./new-guard.sh")] }) }),
      ),
  });
  const user = mount({ commits: [PIN, LIBRARY] });
  expect(await screen.findByText("./old-guard.sh")).toBeInTheDocument();
  expect(screen.getByText("At")).toHaveTextContent("At 9f8e7d6");
  await user.click(screen.getByRole("button", { name: "next commit" }));
  expect(await screen.findByText("./new-guard.sh")).toBeInTheDocument();
  expect(screen.queryByText("./old-guard.sh")).not.toBeInTheDocument();
  expect(screen.queryByText(/^At\b/)).not.toBeInTheDocument();
});

test("opened read-only the peek has no actions and no Used by links, and ends with Open in Skills", async () => {
  serve({
    "GET /api/library/plugins/review%40acme?": () =>
      json(
        detail({
          contents: null,
          contentsNote: "Contents not read yet",
          canRead: true,
          usedBy: { templates: [{ name: "dev", pin: `commit:${PIN}`, agents: 1 }], overlays: [] },
        }),
      ),
  });
  mount({ readOnly: true, commits: [PIN] });
  await screen.findByText("dev");
  expect(screen.queryByRole("button", { name: "Read contents" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add its marketplace" })).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "dev" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open in Skills" })).toHaveAttribute(
    "href",
    "/skills/plugins",
  );
});

test("a load failure shows the error line and Retry loads the detail", async () => {
  let ok = false;
  const { dialog: d, user } = await open({
    "GET /api/library/plugins/review%40acme": () =>
      ok
        ? json(detail({ contents: contents({ hooks: [hook("./back.sh")] }) }))
        : json({ error: { code: "x", message: "x" } }, 500),
  });
  expect(await d.findByText("Couldn't load the plugin.")).toBeInTheDocument();
  ok = true;
  await user.click(d.getByRole("button", { name: "Retry" }));
  expect(await d.findByText("./back.sh")).toBeInTheDocument();
});

test("hostile text in hooks, servers and sources is shown as tokens, never as the characters themselves", async () => {
  const { dialog: d } = await open({
    "GET /api/library/plugins/review%40acme": () =>
      json(
        detail({
          source: { kind: "external", detail: "git: https://evil.test/‮x" },
          contents: contents({
            hooks: [hook("rm -rf /‮txt.sh", { matcher: "Ba‮sh", event: "Pre\u001bTool" })],
            mcp: [
              {
                name: "srv",
                kind: "stdio",
                command: "node",
                args: ["a‮b"],
                env: [{ name: "TOKEN​", value: "v‮" }],
                url: null,
                headers: [],
              },
              {
                name: "remote",
                kind: "http",
                command: null,
                args: [],
                env: [],
                url: "https://x.test/‮",
                headers: ["X-Key⁦"],
              },
            ],
            summary: { ...NO_CONTENTS, hooks: 1, mcp: 2 },
          }),
        }),
      ),
  });
  await d.findByText(/rm -rf/);
  const body = document.body.textContent ?? "";
  const hidden = new Set([0x202e, 0x2066, 0x200b, 0x1b]);
  expect([...body].some((c) => hidden.has(c.codePointAt(0) ?? 0))).toBe(false);
  for (const token of ["⟨U+202E⟩", "⟨ESC⟩", "⟨U+200B⟩", "⟨U+2066⟩"]) expect(body).toContain(token);
  expect(d.getByText(/rm -rf \/⟨U\+202E⟩txt\.sh/)).toBeInTheDocument();
  expect(d.getByText(/Ba⟨U\+202E⟩sh/)).toBeInTheDocument();
});

test("MCP servers show their kind and full command, args, env and headers or URL", async () => {
  const { dialog: d } = await open({
    "GET /api/library/plugins/review%40acme": () =>
      json(
        detail({
          contents: contents({
            mcp: [
              {
                name: "local",
                kind: "stdio",
                command: "uvx",
                args: ["tool", "--flag"],
                env: [
                  { name: "MODE", value: "fast" },
                  { name: "SECRET", value: null },
                ],
                url: null,
                headers: [],
              },
              {
                name: "remote",
                kind: "http",
                command: null,
                args: [],
                env: [],
                url: "https://mcp.example.com/sse",
                headers: ["Authorization"],
              },
            ],
            summary: { ...NO_CONTENTS, mcp: 2 },
          }),
        }),
      ),
  });
  const servers = within(await d.findByRole("list", { name: "MCP servers" }));
  expect(servers.getByText(/uvx tool --flag/)).toBeInTheDocument();
  expect(servers.getByText(/MODE=fast/)).toBeInTheDocument();
  expect(servers.getByText(/^SECRET$|SECRET(?!=)/)).toBeInTheDocument();
  expect(servers.getByText(/stdio/)).toBeInTheDocument();
  expect(servers.getByText(/https:\/\/mcp\.example\.com\/sse/)).toBeInTheDocument();
  expect(servers.getByText(/headers: Authorization/)).toBeInTheDocument();
});

test("a plugin that follows its own source says it can't be pinned, and the host copy's version shows", async () => {
  const { dialog: d } = await open({
    "GET /api/library/plugins/review%40acme": () =>
      json(
        detail({
          pinnable: false,
          state: "cant_pin",
          hostVersion: "1.2.0",
          source: { kind: "external", detail: "github: acme/review" },
        }),
      ),
  });
  expect(await d.findByText("Can't be pinned: it follows its own source.")).toBeInTheDocument();
  expect(d.getByText("Also on this host (1.2.0)")).toBeInTheDocument();
});

test("Provides clamps a long kind past 20 and Show all reveals the rest", async () => {
  const names = Array.from({ length: 34 }, (_, i) => `skill-${i + 1}`);
  const { dialog: d, user } = await open({
    "GET /api/library/plugins/review%40acme": () =>
      json(
        detail({
          contents: contents({
            provides: { skills: names, commands: [], agents: [], outputStyles: [] },
            summary: { ...NO_CONTENTS, skills: 34 },
          }),
        }),
      ),
  });
  const show = await d.findByRole("button", { name: "Show all 34" });
  expect(d.queryByText(/skill-34/)).not.toBeInTheDocument();
  expect(d.getByText(/skill-20\b/)).toBeInTheDocument();
  await user.click(show);
  expect(d.getByText(/skill-34/)).toBeInTheDocument();
  expect(d.queryByRole("button", { name: "Show all 34" })).not.toBeInTheDocument();
});

test("while loading, the placeholder has one row per hook, server and code part the summary counts, at most six", async () => {
  const gate = new Promise<void>(() => {});
  const list = baseList(
    plugin("review@acme", { contentsSummary: { ...NO_CONTENTS, hooks: 2, mcp: 1, codeParts: 1 } }),
  );
  const { dialog: d } = await open(
    { "GET /api/library/plugins/review%40acme": async () => (await gate, json(detail())) },
    list,
  );
  const status = d.getByRole("status");
  const rows = status.querySelector("[aria-hidden='true']")?.children.length;
  expect(rows).toBe(4);
});
