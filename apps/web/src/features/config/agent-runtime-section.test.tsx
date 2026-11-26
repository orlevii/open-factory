import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { installInputModality } from "@/lib/input-modality";
import { QueryWrap } from "@/test/config-harness";
import { json, mockApi } from "@/test/mock-api";
import { agentSummary } from "@/test/session-fixtures";
import { AgentRuntimeSection } from "./agent-runtime-section";
import { AGENT_RUNTIME_COPY, RUNTIME_COPY } from "./messages";

let off = () => {};
beforeEach(() => {
  off = installInputModality();
});
afterEach(() => off());

function api(
  allowLocalRuntime = true,
  patch = () => json({ agent: agentSummary({ slug: "ana", runtime: "local" }) }),
) {
  return mockApi({
    "GET /api/settings/factory": () =>
      json({
        warmWindowMinutes: 70,
        memberUpdateDebounceSeconds: 30,
        allowLocalRuntime,
        defaultImage: "img",
        updatedAt: null,
        updatedBy: null,
      }),
    "PATCH /api/agents/ana": patch,
  });
}

const show = (
  o: { runtime?: "docker" | "local"; templateRuntime?: string; templateBypass?: boolean } = {},
) =>
  render(
    <QueryWrap>
      <AgentRuntimeSection
        agent={agentSummary({ slug: "ana", runtime: o.runtime ?? "docker" })}
        templateRuntime={o.templateRuntime ?? "docker"}
        templateBypass={o.templateBypass ?? false}
      />
    </QueryWrap>,
  );
const local = () => screen.getByRole("radio", { name: "Local" });
const patches = (m: ReturnType<typeof mockApi>) => m.calls.filter((c) => c.method === "PATCH");

test("picking Local asks first, and only the confirmation switches the agent", async () => {
  const m = api();
  show();
  await userEvent.click(local());
  const dialog = await screen.findByRole("alertdialog", { name: "Run @ana outside the sandbox?" });
  expect(dialog).toHaveTextContent(AGENT_RUNTIME_COPY.toLocalBody);
  expect(patches(m)).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Run @ana locally" }));
  await waitFor(() =>
    expect(patches(m)).toEqual([expect.objectContaining({ body: { runtime: "local" } })]),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

test("cancelling the confirmation changes nothing", async () => {
  const m = api();
  show();
  await userEvent.click(local());
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(patches(m)).toHaveLength(0);
  expect(screen.getByRole("radio", { name: "Docker" })).toBeChecked();
});

test("a refused switch keeps the dialog open with the server's reason", async () => {
  api(true, () =>
    json(
      {
        error: {
          code: "validation_error",
          message: "Bypass mode needs Docker.",
          fields: { runtime: "Bypass mode needs Docker." },
        },
      },
      400,
    ),
  );
  show();
  await userEvent.click(local());
  await userEvent.click(await screen.findByRole("button", { name: "Run @ana locally" }));
  expect(await screen.findByRole("alertdialog")).toHaveTextContent("Bypass mode needs Docker.");
});

test.each([
  ["the factory refuses Local", false, false, RUNTIME_COPY.localDisabled],
  ["the template is in Bypass mode", true, true, AGENT_RUNTIME_COPY.bypassTemplate],
])(
  "when %s, Local is aria-disabled with the reason, and picking it asks nothing",
  async (_n, allow, bypass, reason) => {
    const m = api(allow);
    show({ templateBypass: bypass });
    await waitFor(() => expect(local()).toHaveAttribute("aria-disabled", "true"));
    expect(local()).toHaveAccessibleDescription(expect.stringContaining(reason.replace(/`/g, "")));
    await userEvent.click(local());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(patches(m)).toHaveLength(0);
  },
);

test("switching back to Docker asks nothing and switches the agent", async () => {
  const m = api(true, () => json({ agent: agentSummary({ slug: "ana", runtime: "docker" }) }));
  show({ runtime: "local" });
  await userEvent.click(screen.getByRole("radio", { name: "Docker" }));
  await waitFor(() =>
    expect(patches(m)).toEqual([expect.objectContaining({ body: { runtime: "docker" } })]),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("a refused switch back to Docker shows the reason on the field", async () => {
  api(true, () => json({ error: { code: "x", message: "Nope." } }, 409));
  show({ runtime: "local" });
  await userEvent.click(screen.getByRole("radio", { name: "Docker" }));
  expect(await screen.findByText("Nope.")).toBeInTheDocument();
});

test("when the template says another runtime, the note says only new agents follow it", async () => {
  api();
  show({ templateRuntime: "local" });
  expect(
    await screen.findByText(/Its template says Local, which applies to new agents/),
  ).toBeInTheDocument();
});
