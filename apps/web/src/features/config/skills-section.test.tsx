import type { SkillGroupsResponse } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { libraryQueryOptions } from "@/lib/library";
import { doc } from "@/test/config-harness";
import { json, mockApi } from "@/test/mock-api";
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
