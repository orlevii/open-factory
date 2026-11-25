import { ApiError, type CreateAgentBody, type PatchAgentBody } from "@open-factory/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PartialSaveError, useAgentFormState } from "@/features/agents/agent-form-state";
import { resetDrafts } from "@/features/sheets/drafts";
import { sessionQueryOptions } from "@/lib/session";
import { agentSummary, mockWorld } from "@/test/agent-screens-fixtures";
import { json } from "@/test/mock-api";
import { alice } from "@/test/render-app";

beforeEach(() => {
  resetDrafts();
  mockWorld();
});
afterEach(() => vi.unstubAllGlobals());

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQueryOptions.queryKey, alice);
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

type Args = Parameters<typeof useAgentFormState>[0];
const mount = (args: Args) =>
  renderHook((a: Args) => useAgentFormState(a), { initialProps: args, wrapper: wrapper() });
const form = { current: null };
const create = (over: Partial<Args> = {}): Args => ({
  mode: "create",
  draftKey: "new-agent",
  form,
  ...over,
});
const lead = agentSummary({ slug: "lead", displayName: "Lead", description: "Leads" });
const edit = (agent = lead): Args => ({
  mode: "edit",
  agent,
  draftKey: `edit-agent:${agent.slug}`,
  form,
});

test("each changed field validates on blur, with the form's messages", async () => {
  const { result } = mount(create());
  await waitFor(() => expect(result.current.credentials).toBeDefined());
  act(() => result.current.set("slug", "Bad_Slug"));
  act(() => result.current.blur("slug"));
  expect(result.current.errors.slug).toBeTruthy();
  // Untouched: leaving it says nothing.
  act(() => result.current.blur("displayName"));
  expect(result.current.errors.displayName).toBeUndefined();
  act(() => result.current.set("displayName", "x"));
  act(() => result.current.set("displayName", ""));
  act(() => result.current.blur("displayName"));
  expect(result.current.errors.displayName).toBe("Enter a display name.");
  act(() => result.current.set("displayName", "x".repeat(81)));
  act(() => result.current.blur("displayName"));
  expect(result.current.errors.displayName).toBe("Use 80 characters or fewer.");
  act(() => result.current.set("description", "x".repeat(501)));
  act(() => result.current.blur("description"));
  expect(result.current.errors.description).toBe("Use 500 characters or fewer.");
  act(() => result.current.blur("template"));
  expect(result.current.errors.template).toBeUndefined();
  // Typing clears a field's error.
  act(() => result.current.set("slug", "okay"));
  expect(result.current.errors.slug).toBeUndefined();
});

test("submit with invalid fields reports them all and sends nothing", async () => {
  const { result } = mount(create());
  await waitFor(() => expect(result.current.credentials).toBeDefined());
  const onSubmit = vi.fn();
  let r: string | undefined;
  await act(async () => {
    r = await result.current.submit(onSubmit);
  });
  expect(r).toBe("invalid");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(Object.keys(result.current.errors).sort()).toEqual(["displayName", "slug", "template"]);
  expect(result.current.attempt).toBe(1);
});

test("New agent: the template fills untouched fields, and the slug is not prefilled", async () => {
  const { result } = mount(create({ prefill: { template: "lead" } }));
  await waitFor(() => expect(result.current.shown.displayName).toBe("Team Lead"));
  expect(result.current.shown.description).toBe("Leads the team");
  expect(result.current.shown.slug).toBe("");
  expect(result.current.shown.credential).toBe("work");
  act(() => result.current.set("displayName", "Mine"));
  expect(result.current.shown.displayName).toBe("Mine");
  const onSubmit = vi.fn(async (_b: CreateAgentBody | PatchAgentBody) => undefined);
  act(() => result.current.set("slug", "mine"));
  await act(async () => {
    await result.current.submit(onSubmit);
  });
  // Untouched grants are left to the template.
  expect(onSubmit).toHaveBeenCalledWith(
    {
      template: "lead",
      slug: "mine",
      displayName: "Mine",
      description: "Leads the team",
      reportsTo: "alice",
      credential: "work",
    },
    undefined,
  );
});

test("Edit: the body is the diff from the saved agent, and no change is nothing to save", async () => {
  const { result } = mount(edit());
  const onSubmit = vi.fn(async (_b: CreateAgentBody | PatchAgentBody) => ({
    ...lead,
    displayName: "Boss",
  }));
  let r: string | undefined;
  await act(async () => {
    r = await result.current.submit(onSubmit);
  });
  expect(r).toBe("nothing");
  expect(result.current.outcome.success).toBe("Nothing to save: no field changed.");
  act(() => result.current.set("displayName", " Boss "));
  await act(async () => {
    r = await result.current.submit(onSubmit);
  });
  expect(r).toBe("ok");
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(onSubmit).toHaveBeenCalledWith({ displayName: "Boss" }, undefined);
  // The sheet closes and toasts; no inline success line.
  expect(result.current.outcome.success).toBeUndefined();
  expect(result.current.outcome.error).toBeUndefined();
  // The saved copy is the new base: saving again changes nothing.
  await act(async () => {
    r = await result.current.submit(onSubmit);
  });
  expect(r).toBe("nothing");
});

test("a server field error lands under its field; any other error is the outcome", async () => {
  const { result } = mount(create());
  await waitFor(() => expect(result.current.credentials).toBeDefined());
  act(() => {
    result.current.set("slug", "taken");
    result.current.set("displayName", "T");
    result.current.set("template", "lead");
  });
  let r: string | undefined;
  await act(async () => {
    r = await result.current.submit(async () => {
      throw new ApiError(409, "slug_taken", "That slug is taken.", {
        fields: { slug: "That slug is taken." },
      });
    });
  });
  expect(r).toBe("failed");
  expect(result.current.errors.slug).toBe("That slug is taken.");
  expect(result.current.pending).toBe(false);
  // A mapped server error is a focus request.
  expect(result.current.attempt).toBe(1);
  expect(result.current.outcome.error).toBeUndefined();
  act(() => result.current.set("slug", "free"));
  await act(async () => {
    r = await result.current.submit(async () => {
      throw new Error("offline");
    });
  });
  expect(r).toBe("failed");
  expect(result.current.outcome.error).toBe("Couldn't reach the server. Try again.");
  // The next edit clears it.
  act(() => result.current.set("displayName", "Tee"));
  expect(result.current.outcome.error).toBeUndefined();
});

type State = ReturnType<typeof useAgentFormState>;
const fill = (s: State) =>
  act(() => {
    s.set("slug", "plug");
    s.set("displayName", "P");
    s.set("template", "lead");
  });
const failCreate = async () => {
  throw new ApiError(500, "boom", "Creating failed: x.");
};

test("Discard clears errors and the outcome", async () => {
  const { result } = mount(create());
  await waitFor(() => expect(result.current.credentials).toBeDefined());
  await act(async () => {
    await result.current.submit(vi.fn());
  });
  expect(result.current.errors.template).toBe("Choose a template.");
  act(() => result.current.discard());
  expect(result.current.errors).toEqual({});
  fill(result.current);
  await act(async () => {
    await result.current.submit(failCreate);
  });
  expect(result.current.outcome.error).toBe("Creating failed: x.");
  act(() => result.current.discard());
  expect(result.current.outcome.error).toBeUndefined();
});

test("a second submit while one is in flight is ignored", async () => {
  const { result } = mount(create());
  await waitFor(() => expect(result.current.credentials).toBeDefined());
  act(() => {
    result.current.set("slug", "dup");
    result.current.set("displayName", "D");
    result.current.set("template", "lead");
  });
  let release = () => {};
  const onSubmit = vi.fn(() => new Promise<void>((res) => (release = res)));
  let first: Promise<string> | undefined;
  let second: string | undefined;
  await act(async () => {
    first = result.current.submit(onSubmit);
    second = await result.current.submit(onSubmit);
  });
  expect(second).toBe("nothing");
  expect(onSubmit).toHaveBeenCalledOnce();
  await act(async () => {
    release();
    await first;
  });
});

test("a draft is restored by the next mount, and a successful submit clears it", async () => {
  const first = mount(create());
  act(() => first.result.current.set("displayName", "Half typed"));
  first.unmount();
  const second = mount(create());
  expect(second.result.current.restored).toBe(true);
  expect(second.result.current.shown.displayName).toBe("Half typed");
  act(() => second.result.current.discard());
  expect(second.result.current.restored).toBe(false);
  expect(second.result.current.shown.displayName).toBe("");
  second.unmount();
  expect(mount(create()).result.current.restored).toBe(false);
});

test("an edit draft keeps the touched field and follows the server for the rest (M1)", () => {
  const first = mount(edit());
  act(() => first.result.current.set("displayName", "Mine"));
  first.unmount();
  // The server changed an untouched field (description) in between.
  const changed = { ...lead, description: "Changed on the server" };
  const second = mount(edit(changed));
  expect(second.result.current.restored).toBe(true);
  expect(second.result.current.values.displayName).toBe("Mine");
  expect(second.result.current.values.description).toBe("Changed on the server");
});

test("a live refetch updates untouched fields and keeps edited ones", () => {
  const { result, rerender } = mount(edit());
  act(() => result.current.set("displayName", "Mine"));
  rerender(edit({ ...lead, displayName: "Server name", description: "Fresh" }));
  expect(result.current.values.displayName).toBe("Mine");
  expect(result.current.values.description).toBe("Fresh");
  // The body is the diff against the refreshed copy.
  const onSubmit = vi.fn(async () => lead);
  return act(async () => {
    await result.current.submit(onSubmit);
    expect(onSubmit).toHaveBeenCalledWith({ displayName: "Mine" }, undefined);
  });
});

test("an edit with no change holds no draft", () => {
  const first = mount(edit());
  act(() => first.result.current.set("displayName", "Changed"));
  act(() => first.result.current.set("displayName", lead.displayName));
  first.unmount();
  expect(mount(edit()).result.current.restored).toBe(false);
});

test("a restored draft's gone credential reads as empty, with the reason", async () => {
  const first = mount(create());
  act(() => first.result.current.set("credential", "prod"));
  first.unmount();
  const second = mount(create());
  await waitFor(() =>
    expect(second.result.current.staleNotes.credential).toBe("That credential was deleted."),
  );
  // One credential left: it is the default again.
  expect(second.result.current.shown.credential).toBe("work");
  act(() => second.result.current.set("credential", "work"));
  expect(second.result.current.staleNotes.credential).toBeUndefined();
});

test("a late edit success after dismiss and reopen keeps the reopened draft", async () => {
  const first = mount(edit());
  act(() => first.result.current.set("displayName", "First"));
  let release = () => {};
  let late: Promise<string> | undefined;
  await act(async () => {
    late = first.result.current.submit(
      () =>
        new Promise<typeof lead>((res) => (release = () => res({ ...lead, displayName: "First" }))),
    );
  });
  first.unmount();
  const reopened = mount(edit());
  act(() => reopened.result.current.set("displayName", "Reopened"));
  await act(async () => {
    release();
    await late;
  });
  reopened.unmount();
  const again = mount(edit());
  expect(again.result.current.restored).toBe(true);
  expect(again.result.current.values.displayName).toBe("Reopened");
});

test("a late create success after dismiss leaves the draft for the host to clear", async () => {
  const first = mount(create({ prefill: { template: "lead" } }));
  await waitFor(() => expect(first.result.current.credentials).toBeDefined());
  act(() => {
    first.result.current.set("slug", "late");
    first.result.current.set("displayName", "Late");
  });
  let release = () => {};
  let late: Promise<string> | undefined;
  await act(async () => {
    late = first.result.current.submit(() => new Promise<void>((res) => (release = res)));
  });
  first.unmount();
  await act(async () => {
    release();
    await late;
  });
  expect(mount(create()).result.current.restored).toBe(true);
});

test("two prefilled fields set in one event both stay the user's when the template lands", async () => {
  const { result } = mount(create({ prefill: { template: "lead" } }));
  act(() => {
    result.current.set("displayName", "Mine");
    result.current.set("description", "Also mine");
  });
  await waitFor(() => expect(result.current.config).toBeDefined());
  expect(result.current.shown.displayName).toBe("Mine");
  expect(result.current.shown.description).toBe("Also mine");
  expect(result.current.touched).toEqual({ displayName: true, description: true });
});

test("no restored banner when the draft equals the server copy", () => {
  const first = mount(edit());
  act(() => first.result.current.set("displayName", "Server will catch up"));
  first.unmount();
  const caught = mount(edit({ ...lead, displayName: "Server will catch up" }));
  expect(caught.result.current.restored).toBe(false);
});

test("New agent: manageOrg is sent when on, and omitted when off", async () => {
  const { result } = mount(create({ prefill: { template: "lead" } }));
  await waitFor(() => expect(result.current.shown.displayName).toBe("Team Lead"));
  act(() => result.current.set("slug", "mine"));
  const onSubmit = vi.fn(async (_b: CreateAgentBody | PatchAgentBody) => undefined);
  await act(async () => {
    await result.current.submit(onSubmit);
  });
  expect(onSubmit.mock.lastCall?.[0]).not.toHaveProperty("manageOrg");
  act(() => result.current.set("manageOrg", true));
  await act(async () => {
    await result.current.submit(onSubmit);
  });
  expect(onSubmit.mock.lastCall?.[0]).toHaveProperty("manageOrg", true);
});

test("manageOrg is an edit field: toggling it is the only change sent", async () => {
  const { result } = mount(edit());
  expect(result.current.changes).toEqual([]);
  act(() => result.current.set("manageOrg", true));
  expect(result.current.changes).toEqual(["manageOrg"]);
  const send = vi.fn(async (b: CreateAgentBody | PatchAgentBody) => ({ ...lead, ...b }) as never);
  await act(async () => {
    await result.current.submit(send);
  });
  expect(send).toHaveBeenCalledWith({ manageOrg: true }, undefined);
});

const withModel =
  (model: string, effort = "") =>
  (_prev: unknown) => ({
    template: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
  });

test("Edit: a model override alone is a config write with no agent patch; undoing it is nothing to save", async () => {
  const { result } = mount(edit());
  act(() => result.current.modelEffort.onChange(withModel("opus")));
  expect(result.current.modelEffortChanged).toBe(true);
  const send = vi.fn(async (_b: CreateAgentBody | PatchAgentBody, _m?: unknown) => lead);
  await act(async () => {
    await result.current.submit(send);
  });
  expect(send).toHaveBeenCalledWith({}, { model: "opus", effort: "" });
  act(() => result.current.modelEffort.onChange(withModel("")));
  expect(result.current.modelEffortChanged).toBe(false);
});

test("Edit: an agent's own model starts as the override, and inheriting again writes an empty one", async () => {
  const own = agentSummary({
    slug: "lead",
    model: { value: "opus", source: "agent" },
    effort: { value: "high", source: "template" },
  });
  const { result } = mount(edit(own));
  // Only what the agent overrides: the template's effort is inherited, not copied.
  expect(result.current.modelEffort.value).toEqual({ template: { model: "opus" } });
  act(() => result.current.modelEffort.onChange(withModel("")));
  const send = vi.fn(async (_b: CreateAgentBody | PatchAgentBody, _m?: unknown) => own);
  await act(async () => {
    await result.current.submit(send);
  });
  expect(send).toHaveBeenCalledWith({}, { model: "", effort: "" });
});

test("Edit: when the config write fails after the agent saved, the outcome says so and a retry sends only the config", async () => {
  const { result } = mount(edit());
  act(() => result.current.set("displayName", "Boss"));
  act(() => result.current.modelEffort.onChange(withModel("opus")));
  const saved = { ...lead, displayName: "Boss" };
  const partial = vi.fn(async () => {
    throw new PartialSaveError(saved, "Saved your changes, but not Model and Effort: Changed.");
  });
  let r: string | undefined;
  await act(async () => {
    r = await result.current.submit(partial);
  });
  expect(r).toBe("failed");
  expect(result.current.outcome.error).toBe(
    "Saved your changes, but not Model and Effort: Changed.",
  );
  const retry = vi.fn(async (_b: CreateAgentBody | PatchAgentBody, _m?: unknown) => saved);
  await act(async () => {
    await result.current.submit(retry);
  });
  expect(retry).toHaveBeenCalledWith({}, { model: "opus", effort: "" });
});

test("New agent: model and effort are off until a template is chosen, then inherit the template's", async () => {
  mockWorld({
    extra: {
      "GET /api/templates/lead/config": () =>
        json({
          doc: { template: { model: "opus" }, settings: {}, mcp: { mcpServers: {} } },
          hashes: { "template.yaml": "h", "settings.json": null, "mcp.json": null },
          issues: [],
          localSkills: [],
          agents: { live: 0, archived: 0, cantStart: 0 },
        }),
    },
  });
  const { result } = mount(create());
  expect(result.current.modelEffort.disabledReason).toBe("Choose a template first");
  act(() => result.current.set("template", "lead"));
  expect(result.current.modelEffort.disabledReason).toBeUndefined();
  await waitFor(() => expect(result.current.modelEffort.base?.template.model).toBe("opus"));
  // Nothing chosen: nothing is written to the new agent's config.
  act(() => result.current.set("slug", "mine"));
  await waitFor(() => expect(result.current.shown.displayName).toBe("Team Lead"));
  const onSubmit = vi.fn(async (_b: CreateAgentBody | PatchAgentBody, _m?: unknown) => undefined);
  await act(async () => {
    await result.current.submit(onSubmit);
  });
  expect(onSubmit.mock.lastCall?.[1]).toBeUndefined();
  act(() => result.current.modelEffort.onChange(withModel("haiku", "low")));
  await act(async () => {
    await result.current.submit(onSubmit);
  });
  expect(onSubmit.mock.lastCall?.[1]).toEqual({ model: "haiku", effort: "low" });
});
