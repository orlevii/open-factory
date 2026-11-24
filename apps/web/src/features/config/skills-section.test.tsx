import type { SkillGroupsResponse } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { libraryQueryOptions } from "@/lib/library";
import { doc } from "@/test/config-harness";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import {
  LIB,
  lastOf,
  MARKETPLACES,
  PluginsForm,
  pinned,
  useMarketplaces,
} from "@/test/plugins-harness";
import { ConfigForm } from "./config-form";

const NO_USE = { templates: 0, agents: 0 };
const ok = (name: string, description = "") => ({
  name,
  description,
  state: "ok" as const,
  usedBy: NO_USE,
});
const bad = (name: string, state: "hidden" | "unusable" | "missing") => ({
  name,
  description: "",
  state,
  usedBy: NO_USE,
});
const PIN = "a1b2c3d".padEnd(40, "0");

const LIBRARY: SkillGroupsResponse = {
  hostDir: "/skills",
  groups: [
    {
      group: "host",
      kind: "host",
      skills: [
        ok("tdd", "Test first."),
        ok("review", "Review a PR."),
        ok("deploy", "Same name as the template's own skill."),
        bad("shadowed", "hidden"),
        bad("gone", "missing"),
      ],
    },
    {
      group: "source:s1",
      kind: "source",
      source: {
        id: "s1",
        kind: "github",
        path: null,
        repo: "acme/x",
        subpath: "",
        branch: "main",
        pin: PIN,
        state: "ready",
        skillCount: 2,
        since: null,
        checking: null,
        update: false,
        checkFailed: false,
      },
      skills: [ok("from-github", "From GitHub."), bad("broken", "unusable")],
    },
    { group: "unknown", kind: "unknown", skills: [bad("ghost", "missing")] },
  ],
};

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => {
  off();
  vi.restoreAllMocks();
});

function Form({
  start = {},
  mode = "agent",
  localSkills = ["deploy"],
  onValue,
  client,
}: {
  start?: unknown;
  mode?: "agent" | "template";
  localSkills?: string[];
  onValue?: (v: unknown) => void;
  client?: QueryClient;
}) {
  const [value, setValue] = useState<unknown>(start);
  const [own] = useState(
    () => client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={own}>
      <ConfigForm
        mode={mode}
        value={value}
        base={mode === "agent" ? doc() : undefined}
        templateName="dev"
        issues={[]}
        localSkills={localSkills}
        onChange={(u) =>
          setValue((p: unknown) => {
            const n = u(p);
            onValue?.(n);
            return n;
          })
        }
      />
    </QueryClientProvider>
  );
}

const useLibrary = (library: unknown = LIBRARY) =>
  mockApi({
    "GET /api/library/skills": () => json(library),
    "GET /api/secrets": () => json({ secrets: [] }),
    "GET /api/templates": () => json({ dir: "/t", templates: [] }),
  });
const last = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)?.[0];
const skillsGroup = () => screen.getByRole("group", { name: "Skills" });
const addButton = () => screen.getByRole("button", { name: "Add skill" });
const open = async () => {
  await userEvent.click(addButton());
  return screen.findByRole("listbox", { name: "Add skill" });
};

test("agent mode: the ghost Add skill sits in the This agent label row", () => {
  useLibrary();
  render(<Form />);
  const row = within(skillsGroup()).getByText(/^This agent/).parentElement as HTMLElement;
  expect(within(row).getByRole("button", { name: "Add skill" })).toBeInTheDocument();
});

test("template mode: the ghost Add skill sits in the Skills label row, above the rows", () => {
  useLibrary();
  render(<Form mode="template" start={{ template: { skills: ["tdd"] } }} />);
  const group = skillsGroup();
  const trigger = within(group).getByRole("button", { name: "Add skill" });
  // The label and the trigger share one row.
  const row = within(group).getByText("Skills").parentElement as HTMLElement;
  expect(row).toContainElement(trigger);
  const rows = within(group).getByRole("button", { name: "Remove skill 1" });
  expect(trigger.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("options are grouped by source, a heading each", async () => {
  useLibrary();
  render(<Form />);
  await open();
  const host = screen.getByRole("group", { name: "Host" });
  expect(
    within(host)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual([expect.stringContaining("tdd"), expect.stringContaining("review")]);
  const gh = screen.getByRole("group", { name: "acme/x" });
  expect(within(gh).getAllByRole("option")).toHaveLength(1);
});

test("hidden, unusable, missing and template-named skills are left out, and the footer counts them", async () => {
  useLibrary();
  render(<Form />);
  await open();
  const names = screen.getAllByRole("option").map((o) => o.textContent ?? "");
  expect(names.join("|")).not.toMatch(/shadowed|broken|gone|deploy|ghost/);
  expect(screen.getByText("3 skills can't be used here: hidden or unusable.")).toBeInTheDocument();
});

test("a name counts once as left out, and not at all when another group offers it as usable", async () => {
  const shared: SkillGroupsResponse = {
    hostDir: "/skills",
    groups: [
      {
        group: "host",
        kind: "host",
        skills: [
          ok("tdd"),
          bad("dup", "hidden"),
          bad("only-bad", "hidden"),
          bad("broken", "hidden"),
        ],
      },
      {
        ...LIBRARY.groups[1],
        skills: [ok("dup", "Usable in a source."), bad("broken", "unusable")],
      },
    ],
  } as SkillGroupsResponse;
  useLibrary(shared);
  render(<Form start={{ template: { skills: ["dup"] } }} />);
  await open();
  expect(screen.getByText("2 skills can't be used here: hidden or unusable.")).toBeInTheDocument();
});

test("picking keeps the popover open, marks Added, writes the draft and announces outside the popover", async () => {
  useLibrary();
  const onValue = vi.fn();
  render(<Form onValue={onValue} />);
  const list = await open();
  await userEvent.click(screen.getByRole("option", { name: /tdd/ }));
  expect(last(onValue)).toEqual({ template: { skills: ["tdd"] } });
  expect(list).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /tdd/ })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("option", { name: /tdd/ })).toHaveTextContent("Added");
  const said = screen.getAllByRole("status").find((s) => s.textContent === "Added tdd");
  expect(said).toBeDefined();
  expect(list.closest('[data-slot="popover-content"]')?.contains(said as Node)).toBe(false);
  // Still announced once the popover is gone.
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Added tdd")).toBe(true);
});

test("the page does not scroll while picking; the last added row scrolls into view on close", async () => {
  useLibrary();
  render(<Form />);
  await open();
  const into = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  await userEvent.click(screen.getByRole("option", { name: /tdd/ }));
  await userEvent.click(screen.getByRole("option", { name: /review/ }));
  expect(into).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(into).toHaveBeenCalledTimes(1));
  expect(into.mock.contexts[0]).toHaveTextContent("review");
});

test("a reopened popover leaves out what was picked", async () => {
  useLibrary();
  render(<Form />);
  await open();
  await userEvent.click(screen.getByRole("option", { name: /tdd/ }));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  await open();
  expect(screen.queryByRole("option", { name: /tdd/ })).toBeNull();
  expect(screen.getByRole("option", { name: /review/ })).toBeInTheDocument();
});

test("selected rows show where they come from and any state", async () => {
  useLibrary();
  render(<Form start={{ template: { skills: ["from-github", "tdd", "shadowed", "ghost"] } }} />);
  await within(skillsGroup()).findByText("GitHub · a1b2c3d");
  const rows = within(skillsGroup()).getAllByRole("listitem");
  const text = (name: string) => rows.find((r) => r.textContent?.includes(name))?.textContent;
  expect(text("from-github")).toContain("GitHub · a1b2c3d");
  expect(text("tdd")).toContain("Host");
  expect(text("shadowed")).toContain("Hidden");
  expect(text("ghost")).toContain("Missing");
});

test("template-local skills are read-only rows", () => {
  useLibrary();
  render(<Form />);
  const list = screen.getByRole("list", { name: "Template skill" });
  expect(list).toHaveTextContent("deployTemplate skill");
  expect(within(list).queryByRole("button")).toBeNull();
});

test("an untrusted description shows its bidi controls as tokens", async () => {
  useLibrary({
    hostDir: "/s",
    groups: [{ group: "host", kind: "host", skills: [ok("sneaky", "safe‮evil")] }],
  });
  render(<Form localSkills={[]} />);
  await open();
  expect(screen.getByRole("option", { name: /sneaky/ })).toHaveTextContent("safe⟨U+202E⟩evil");
});

test("empty states: nothing in Skills, and everything already added", async () => {
  useLibrary({ hostDir: "/s", groups: [{ group: "host", kind: "host", skills: [] }] });
  const first = render(<Form localSkills={[]} />);
  await open();
  expect(screen.getByText("No skills in Skills yet.")).toBeInTheDocument();
  first.unmount();

  useLibrary({ hostDir: "/s", groups: [{ group: "host", kind: "host", skills: [ok("tdd")] }] });
  render(<Form localSkills={[]} start={{ template: { skills: ["tdd"] } }} />);
  await open();
  expect(screen.getByText("Every skill is already added.")).toBeInTheDocument();
});

test("when every skill is unusable, the empty line doesn't claim there are none", async () => {
  useLibrary({
    hostDir: "/s",
    groups: [{ group: "host", kind: "host", skills: [{ ...ok("broken"), state: "unusable" }] }],
  });
  render(<Form localSkills={[]} />);
  await open();
  expect(screen.getByText("1 skill can't be used here: hidden or unusable.")).toBeInTheDocument();
  expect(screen.queryByText("No skills in Skills yet.")).not.toBeInTheDocument();
});

test("the picker does not fetch on mount: the Library list is already cached", async () => {
  const api = useLibrary();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(libraryQueryOptions.queryKey, LIBRARY);
  render(<Form client={client} />);
  expect(screen.getByRole("button", { name: "Add skill" })).toBeInTheDocument();
  await open();
  expect(screen.getByRole("option", { name: /tdd/ })).toBeInTheDocument();
  expect(api.calls.filter((c) => c.url === "/api/library/skills")).toHaveLength(0);
});

// Plugins (spec §10.5, §7.4).

const addPlugin = () => screen.getByRole("button", { name: "Add plugin" });
const openPlugins = async () => {
  await userEvent.click(addPlugin());
  return screen.findByRole("listbox", { name: "Add plugin" });
};
const PLUGIN_PIN = "a1b2c3d".padEnd(40, "0");

describe("plugin picker", () => {
  beforeEach(() => fakeMatchMedia.install(false));

  test("template mode: a first pick declares its marketplace pinned to the Library's commit", async () => {
    useMarketplaces();
    const onValue = vi.fn();
    render(<PluginsForm onValue={onValue} />);
    await openPlugins();
    await userEvent.click(await screen.findByRole("option", { name: /review@acme/ }));
    expect(lastOf(onValue)).toEqual({
      settings: {
        enabledPlugins: { "review@acme": true },
        extraKnownMarketplaces: { acme: pinned(LIB) },
      },
    });
  });

  test("another plugin of a declared marketplace joins its pin", async () => {
    useMarketplaces();
    const onValue = vi.fn();
    render(
      <PluginsForm
        onValue={onValue}
        start={{
          settings: {
            enabledPlugins: { "review@acme": true },
            extraKnownMarketplaces: { acme: pinned(PLUGIN_PIN) },
          },
        }}
      />,
    );
    await openPlugins();
    await userEvent.click(await screen.findByRole("option", { name: /lint@acme/ }));
    expect(lastOf(onValue)).toEqual({
      settings: {
        enabledPlugins: { "review@acme": true, "lint@acme": true },
        extraKnownMarketplaces: { acme: pinned(PLUGIN_PIN) },
      },
    });
  });

  test("options are grouped by marketplace; refused sources are left out and counted; the footer points to Skills", async () => {
    useMarketplaces();
    render(<PluginsForm />);
    await openPlugins();
    const acme = await screen.findByRole("group", { name: "acme" });
    expect(
      within(acme)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      expect.stringContaining("review@acme"),
      expect.stringContaining("lint@acme"),
      expect.stringContaining("loose@acme"),
    ]);
    expect(screen.queryByRole("option", { name: /sneaky/ })).toBeNull();
    expect(screen.getByText("1 plugin can't be used here: refused source.")).toBeInTheDocument();
    expect(screen.getByText("Add marketplaces in Skills")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /loose@acme/ })).toHaveTextContent("Can't be pinned");
  });

  test("a plugin that follows its own source can't join a pinned declaration, and the picker says why", async () => {
    useMarketplaces();
    const onValue = vi.fn();
    render(
      <PluginsForm
        onValue={onValue}
        start={{ settings: { extraKnownMarketplaces: { acme: pinned(PLUGIN_PIN) } } }}
      />,
    );
    await openPlugins();
    await userEvent.click(await screen.findByRole("option", { name: /loose@acme/ }));
    const why = "loose@acme can't be pinned. Switch acme to Latest to add it.";
    expect(screen.getAllByText(why).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("status").some((s) => s.textContent === why)).toBe(true);
    expect(onValue).not.toHaveBeenCalled();
  });

  test("a first pick that can't be pinned doesn't point at a Latest switch that doesn't exist", async () => {
    useMarketplaces();
    const onValue = vi.fn();
    render(<PluginsForm onValue={onValue} />);
    await openPlugins();
    await userEvent.click(await screen.findByRole("option", { name: /loose@acme/ }));
    expect(
      screen.getAllByText(
        "loose@acme can't be pinned. Add another acme plugin first, then switch acme to Latest.",
      ).length,
    ).toBeGreaterThan(0);
    expect(onValue).not.toHaveBeenCalled();
  });

  test("it joins a Latest declaration", async () => {
    useMarketplaces();
    const onValue = vi.fn();
    render(
      <PluginsForm
        onValue={onValue}
        start={{ settings: { extraKnownMarketplaces: { acme: pinned() } } }}
      />,
    );
    await openPlugins();
    await userEvent.click(await screen.findByRole("option", { name: /loose@acme/ }));
    expect(lastOf(onValue)).toMatchObject({ settings: { enabledPlugins: { "loose@acme": true } } });
  });

  test("an official marketplace is pinned to the tag at the Library's commit", async () => {
    useMarketplaces();
    const onValue = vi.fn();
    render(<PluginsForm onValue={onValue} />);
    await openPlugins();
    await userEvent.click(
      await screen.findByRole("option", { name: /docs@claude-plugins-official/ }),
    );
    expect(lastOf(onValue).settings.extraKnownMarketplaces["claude-plugins-official"]).toEqual({
      source: { source: "github", repo: "anthropics/claude-plugins-official", ref: "v1.0.0" },
    });
  });

  test("an official marketplace with no tag at its commit refuses the pick", async () => {
    useMarketplaces(
      MARKETPLACES.map((m) => (m.name === "claude-plugins-official" ? { ...m, tags: {} } : m)),
    );
    const onValue = vi.fn();
    render(<PluginsForm onValue={onValue} />);
    await openPlugins();
    await userEvent.click(
      await screen.findByRole("option", { name: /docs@claude-plugins-official/ }),
    );
    expect(
      screen.getAllByText(
        "claude-plugins-official can only be pinned to a tag. Fetch a tag in Skills, or use Latest.",
      ).length,
    ).toBeGreaterThan(0);
    expect(onValue).not.toHaveBeenCalled();
  });

  test("a folder marketplace is declared live, with no ref", async () => {
    useMarketplaces();
    const onValue = vi.fn();
    render(<PluginsForm onValue={onValue} />);
    await openPlugins();
    await userEvent.click(await screen.findByRole("option", { name: /local@mine/ }));
    expect(lastOf(onValue).settings.extraKnownMarketplaces.mine).toEqual({
      source: { source: "directory", path: "/home/me/plugins" },
    });
  });

  test("removing the last plugin of a marketplace leaves its declaration", async () => {
    useMarketplaces();
    const onValue = vi.fn();
    render(
      <PluginsForm
        onValue={onValue}
        start={{
          settings: {
            enabledPlugins: { "review@acme": true },
            extraKnownMarketplaces: { acme: pinned(PLUGIN_PIN) },
          },
        }}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Remove review@acme" }));
    expect(lastOf(onValue)).toEqual({
      settings: { extraKnownMarketplaces: { acme: pinned(PLUGIN_PIN) } },
    });
  });

  test("a row shows its version and contents, and its server note", async () => {
    useMarketplaces();
    render(
      <PluginsForm
        start={{
          settings: {
            enabledPlugins: { "review@acme": true },
            extraKnownMarketplaces: { acme: pinned(LIB) },
          },
        }}
      />,
    );
    const group = await screen.findByRole("group", { name: "acme" });
    expect(await within(group).findByText("1.3.0")).toBeInTheDocument();
    expect(within(group).getByText("1 skill")).toBeInTheDocument();
  });

  test("a plugin row's View opens the read-only peek at that pin", async () => {
    const api = useMarketplaces(MARKETPLACES, {
      "GET /api/library/plugins/review%40acme?": () =>
        json({
          key: "review@acme",
          name: "review",
          marketplace: "acme",
          from: "library",
          commit: PLUGIN_PIN,
          version: "1.2.0",
          description: "Reviews pull requests",
          pinnable: true,
          state: "ok",
          source: { kind: "relative", detail: "./plugins/review" },
          contents: null,
          contentsNote: "Contents not read yet",
          canRead: false,
          hostVersion: null,
          usedBy: { templates: [], overlays: [] },
        }),
    });
    const root = createRootRoute();
    const stub = (path: string, component: () => ReactNode = () => null) =>
      createRoute({ getParentRoute: () => root, path, component });
    const router = createRouter({
      routeTree: root.addChildren([
        stub("/", () => (
          <PluginsForm
            start={{
              settings: {
                enabledPlugins: { "review@acme": true },
                extraKnownMarketplaces: { acme: pinned(PLUGIN_PIN) },
              },
            }}
          />
        )),
        stub("/skills/plugins"),
        stub("/templates/$name"),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(<RouterProvider router={router} />);
    await userEvent.click(await screen.findByRole("button", { name: "View review@acme" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("link", { name: "Open in Skills" })).toBeInTheDocument();
    expect(
      api.calls.some((c) => c.url === `/api/library/plugins/review%40acme?commit=${PLUGIN_PIN}`),
    ).toBe(true);
  });
});
