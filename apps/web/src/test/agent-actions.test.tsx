import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import {
  agentSummary,
  mockWorld,
  templateConfig,
  templateDetail,
  type World,
} from "@/test/agent-screens-fixtures";
import { json } from "@/test/mock-api";
import { alice, renderApp } from "@/test/render-app";

vi.mock("@/lib/auth-client", () => ({ authClient: { getSession: vi.fn() } }));
vi.mock("@/lib/ws", () => ({
  connectWs: () => ({ close() {}, status: () => "open", send: () => true }),
}));
afterEach(() => vi.unstubAllGlobals());

const lead = agentSummary({
  slug: "lead",
  displayName: "Team Lead",
  template: "tech-lead",
  status: "idle",
});
const world = (over: World = {}) =>
  mockWorld({
    agents: [lead],
    details: { "tech-lead": templateDetail(templateConfig({ name: "tech-lead" })) },
    ...over,
  });
const open = async () => {
  renderApp("/agents/lead/edit", alice);
  return screen.findByRole("region", { name: "Agent actions" });
};

test("Edit shows template and slug read-only at the top", async () => {
  world();
  await open();
  const line = screen.getByText(
    (_c, el) => el?.tagName === "P" && el.textContent === "Template tech-lead · @lead",
  );
  expect(line).toBeInTheDocument();
});

test("Re-sync success names the backup folder in mono and the restart", async () => {
  world({
    extra: {
      "POST /api/agents/lead/resync": () =>
        json({ agent: lead, backupDir: ".factory/resync/2026-11-19T10-22-31Z" }),
    },
  });
  const section = await open();
  await userEvent.click(within(section).getByRole("button", { name: "Re-sync" }));
  const path = await within(section).findByText(".factory/resync/2026-11-19T10-22-31Z");
  expect(path.tagName).toBe("CODE");
  const line = path.closest("[role=status]") as HTMLElement;
  expect(line).toHaveTextContent(
    "Re-synced. Previous files saved in .factory/resync/2026-11-19T10-22-31Z. The agent restarts when idle.",
  );
});

test("Re-sync with nothing differing says so", async () => {
  world({
    agents: [{ ...lead, status: "hibernated" }],
    extra: { "POST /api/agents/lead/resync": () => json({ agent: lead }) },
  });
  const section = await open();
  await userEvent.click(within(section).getByRole("button", { name: "Re-sync" }));
  expect(await within(section).findByText("Re-synced. Nothing differed.")).toBeInTheDocument();
});

test("Re-sync 409 template_invalid shows a crimson line linking the template", async () => {
  world({
    extra: {
      "POST /api/agents/lead/resync": () =>
        json(
          { error: { code: "template_invalid", message: "Template tech-lead has errors." } },
          409,
        ),
    },
  });
  const section = await open();
  await userEvent.click(within(section).getByRole("button", { name: "Re-sync" }));
  const link = await within(section).findByRole("link", { name: "tech-lead" });
  expect(link).toHaveAttribute("href", "/templates/tech-lead");
  const alert = link.closest("[role=alert]") as HTMLElement;
  expect(alert).toHaveTextContent("Template tech-lead has errors.");
  expect(alert.querySelector(".text-destructive")).not.toBeNull();
});

test("Re-sync is disabled with a visible reason when the template has errors", async () => {
  world({
    details: {
      "tech-lead": templateDetail(templateConfig({ name: "tech-lead" }), [
        { severity: "error", file: "template.yaml", message: "bad" },
      ]),
    },
  });
  const section = await open();
  await vi.waitFor(() =>
    expect(within(section).getByRole("button", { name: "Re-sync" })).toHaveAttribute(
      "aria-disabled",
      "true",
    ),
  );
  expect(within(section).getByText(/has errors\./)).toBeInTheDocument();
});

test("Re-sync 502 shows the plugin line and a collapsed Show output", async () => {
  world({
    extra: {
      "POST /api/agents/lead/resync": () =>
        json(
          {
            error: {
              code: "plugin_install_failed",
              message: "Plugin install failed.",
              output: "boom output",
            },
          },
          502,
        ),
    },
  });
  const section = await open();
  await userEvent.click(within(section).getByRole("button", { name: "Re-sync" }));
  expect(
    await within(section).findByText(/Plugin install failed\. Some files were already copied/),
  ).toBeInTheDocument();
  const details = within(section).getByText("Show output").closest("details");
  expect(details).not.toHaveAttribute("open");
  expect(within(details as HTMLElement).getByText("boom output")).toBeInTheDocument();
});

test("Archive is an ink ghost button and lands on the list with the Undo line", async () => {
  world({
    extra: {
      "POST /api/agents/lead/archive": () =>
        json({ agent: { ...lead, archivedAt: "2026-11-19T10:00:00Z" } }),
    },
  });
  renderApp("/agents/lead/edit", alice);
  const section = await screen.findByRole("region", { name: "Agent actions" });
  const button = within(section).getByRole("button", { name: "Archive @lead" });
  expect(button).toHaveAttribute("data-variant", "ghost");
  expect(button).not.toHaveClass("text-destructive");
  await userEvent.click(button);
  expect(await screen.findByText("Archived @lead.")).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeInTheDocument();
});

test("Archive with reports shows the has_reports message with links", async () => {
  world({
    extra: {
      "POST /api/agents/lead/archive": () =>
        json(
          {
            error: {
              code: "has_reports",
              message: "@dev-1 and @dev-2 report to this agent. Change their manager first.",
              reports: ["dev-1", "dev-2"],
            },
          },
          409,
        ),
    },
  });
  const section = await open();
  await userEvent.click(within(section).getByRole("button", { name: "Archive @lead" }));
  const link = await within(section).findByRole("link", { name: "@dev-1" });
  expect(link).toHaveAttribute("href", "/agents/dev-1/edit");
  expect(within(section).getByRole("link", { name: "@dev-2" })).toHaveAttribute(
    "href",
    "/agents/dev-2/edit",
  );
  expect(link.closest("[role=alert]")).toHaveTextContent(
    "@dev-1 and @dev-2 report to this agent. Change their manager first.",
  );
});

test("an archived agent: the notice, Restore, and manager_archived focuses Manager", async () => {
  const archived = { ...lead, archivedAt: "2026-11-19T10:00:00Z", reportsTo: null };
  world({
    agents: [],
    archived: [archived],
    extra: {
      "POST /api/agents/lead/unarchive": () =>
        json(
          {
            error: {
              code: "manager_archived",
              message: "Its manager @boss is archived. Change its manager first.",
            },
          },
          409,
        ),
    },
  });
  const section = await open();
  expect(screen.getByText("This agent is archived.")).toBeInTheDocument();
  expect(within(section).queryByRole("button", { name: "Re-sync" })).not.toBeInTheDocument();
  expect(within(section).queryByRole("button", { name: /Archive/ })).not.toBeInTheDocument();
  await userEvent.click(within(section).getByRole("button", { name: "Restore" }));
  expect(
    await within(section).findByText("Its manager @boss is archived. Change its manager first."),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("Manager")).toHaveFocus();
});

test("Restore success says so", async () => {
  const archived = { ...lead, archivedAt: "2026-11-19T10:00:00Z" };
  world({
    agents: [],
    archived: [archived],
    extra: { "POST /api/agents/lead/unarchive": () => json({ agent: lead }) },
  });
  const section = await open();
  await userEvent.click(within(section).getByRole("button", { name: "Restore" }));
  expect(await within(section).findByText(/Restored @lead\./)).toBeInTheDocument();
});

test("an unknown agent shows the not-found state", async () => {
  world({
    extra: {
      "GET /api/agents/nobody": () =>
        json({ error: { code: "agent_not_found", message: "No agent named nobody" } }, 404),
    },
  });
  renderApp("/agents/nobody/edit", alice);
  expect(await screen.findByText("Agent not found.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to agents" })).toHaveAttribute("href", "/agents");
});

test("a pending re-sync is announced once: the button keeps its label", async () => {
  world({ extra: { "POST /api/agents/lead/resync": () => new Promise<Response>(() => {}) } });
  const section = await open();
  await userEvent.click(within(section).getByRole("button", { name: "Re-sync" }));
  expect(await within(section).findAllByText("Re-syncing…")).toHaveLength(1);
  expect(within(section).getByRole("button", { name: "Re-sync" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
});
