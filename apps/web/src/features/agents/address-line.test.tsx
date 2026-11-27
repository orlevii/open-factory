import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { agentSummary } from "@/test/session-fixtures";
import { AddressLine } from "./address-line";

afterEach(() => {
  opened.mockClear();
  handleBlur.mockClear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function routes(taken: string[] = []) {
  mockApi({
    "GET /api/agents?ended=exclude": () =>
      json({
        agents: taken.map((handle) => agentSummary({ handle: handle })),
        running: { count: 0 },
        more: false,
      }),
    "GET /api/agents?ended=only": () => json({ agents: [], running: { count: 0 }, more: false }),
    "GET /api/users": () => json({ users: [] }),
  });
}

const opened = vi.fn();
const handleBlur = vi.fn();

function Harness({
  initialName = "",
  forceOpen = false,
  error,
}: {
  initialName?: string;
  forceOpen?: boolean;
  error?: string;
}) {
  const [name, setName] = useState(initialName);
  const [handle, setHandle] = useState("");
  const [touched, setTouched] = useState(false);
  const [force, setForce] = useState(forceOpen);
  return (
    <>
      <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="button" onClick={() => setForce(true)}>
        Force
      </button>
      <AddressLine
        name={name}
        handle={handle}
        handleTouched={touched}
        onHandle={(s) => {
          setHandle(s);
          setTouched(true);
        }}
        error={error}
        forceOpen={force}
        onBlur={handleBlur}
        onOpened={() => {
          opened();
          setForce(false);
        }}
      />
    </>
  );
}

function setup(props: React.ComponentProps<typeof Harness> = {}, taken: string[] = []) {
  routes(taken);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Harness {...props} />
    </QueryClientProvider>,
  );
}

const line = () => screen.getByText(/^Handle/).closest("p") as HTMLElement;

test("the address follows each keystroke", async () => {
  const user = userEvent.setup();
  setup({ initialName: "" });
  await user.type(screen.getByLabelText("Name"), "Priya");
  await waitFor(() => expect(line()).toHaveTextContent("Handle @priya · Change"));
  await user.type(screen.getByLabelText("Name"), " Nair");
  expect(line()).toHaveTextContent("Handle @priya-nair · Change");
});

test("a taken address shows its suffix", async () => {
  setup({ initialName: "Priya Nair" }, ["priya-nair"]);
  await waitFor(() => expect(line()).toHaveTextContent("@priya-nair-2"));
});

test("Change opens the input with the derived handle, focused", async () => {
  const user = userEvent.setup();
  setup({ initialName: "Priya Nair" });
  const change = screen.getByRole("button", { name: "Change" });
  expect(change.getAttribute("type")).toBe("button");
  await user.click(change);
  const input = screen.getByLabelText("Handle");
  expect(input).toHaveValue("priya-nair");
  expect(input).toHaveFocus();
});

test("once edited the name no longer drives the handle", async () => {
  const user = userEvent.setup();
  setup({ initialName: "Priya" });
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.clear(screen.getByLabelText("Handle"));
  await user.type(screen.getByLabelText("Handle"), "ops");
  await user.type(screen.getByLabelText("Name"), " Nair");
  expect(screen.getByLabelText("Handle")).toHaveValue("ops");
});

test("an empty derivation reads 'choose one'", () => {
  setup({ initialName: "" });
  expect(line()).toHaveTextContent("Handle: choose one · Change");
});

test("forceOpen opens the input focused, with its error, and reports it", async () => {
  setup({ initialName: "", forceOpen: true, error: "Pick an address." });
  const input = await screen.findByLabelText("Handle");
  expect(input).toHaveFocus();
  expect(screen.getByText("Pick an address.")).toBeInTheDocument();
  await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
});

test("forceOpen after the Name blurred moves focus to the handle input", async () => {
  const user = userEvent.setup();
  setup({ initialName: "" });
  await user.click(screen.getByLabelText("Name"));
  await user.tab();
  await user.click(screen.getByRole("button", { name: "Force" }));
  expect(await screen.findByLabelText("Handle")).toHaveFocus();
  expect(opened).toHaveBeenCalledTimes(1);
});

test("forceOpen with the field already open (via Change) refocuses it", async () => {
  const user = userEvent.setup();
  setup({ initialName: "Priya" });
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(screen.getByLabelText("Name"));
  expect(screen.getByLabelText("Name")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Force" }));
  await waitFor(() => expect(screen.getByLabelText("Handle")).toHaveFocus());
  expect(opened).toHaveBeenCalledTimes(1);
});

test("an error opens the field even without forceOpen, in the handle's note", () => {
  setup({ initialName: "Priya", error: "That address is taken." });
  expect(screen.getByLabelText("Handle")).toHaveAccessibleDescription("That address is taken.");
  expect(screen.getByText("That address is taken.").closest(".field-note")).not.toBeNull();
});

test("leaving the handle input passes the blur event on", async () => {
  const user = userEvent.setup();
  setup({ initialName: "Priya" });
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(screen.getByLabelText("Name"));
  expect(handleBlur).toHaveBeenCalledOnce();
  expect(handleBlur.mock.calls[0]?.[0]).toHaveProperty("relatedTarget");
});

test("a new agent's line draws no face: its face comes from the ref the server makes", async () => {
  const user = userEvent.setup();
  setup({ initialName: "Priya" });
  await user.type(screen.getByLabelText("Name"), "x");
  expect(line()).toHaveTextContent("@priyax");
  expect(document.querySelector("[data-agent-avatar]")).toBeNull();
});

test("the edit line draws the agent's own avatar, the template's avatar.svg when it has one", () => {
  routes();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddressLine
        name="Dev"
        handle="dev"
        handleTouched
        onHandle={() => {}}
        agentRef="a1b2c3d4"
        avatar={{ template: "lead", avatarVersion: "v1", color: 4 }}
      />
    </QueryClientProvider>,
  );
  expect(document.querySelector("[data-agent-avatar] img")).toHaveAttribute(
    "src",
    "/api/templates/lead/avatar.svg?v=v1",
  );
});
