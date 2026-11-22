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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function routes(taken: string[] = []) {
  mockApi({
    "GET /api/agents?ended=exclude": () =>
      json({
        agents: taken.map((slug) => agentSummary({ slug })),
        running: { count: 0, max: 8 },
        more: false,
      }),
    "GET /api/agents?ended=only": () =>
      json({ agents: [], running: { count: 0, max: 8 }, more: false }),
    "GET /api/users": () => json({ users: [] }),
  });
}

const opened = vi.fn();

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
  const [slug, setSlug] = useState("");
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
        slug={slug}
        slugTouched={touched}
        onSlug={(s) => {
          setSlug(s);
          setTouched(true);
        }}
        error={error}
        forceOpen={force}
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

const line = () => screen.getByText(/^Address/).closest("p") as HTMLElement;

test("the address follows each keystroke", async () => {
  const user = userEvent.setup();
  setup({ initialName: "" });
  await user.type(screen.getByLabelText("Name"), "Priya");
  await waitFor(() => expect(line()).toHaveTextContent("Address @priya · Change"));
  await user.type(screen.getByLabelText("Name"), " Nair");
  expect(line()).toHaveTextContent("Address @priya-nair · Change");
});

test("a taken address shows its suffix", async () => {
  setup({ initialName: "Priya Nair" }, ["priya-nair"]);
  await waitFor(() => expect(line()).toHaveTextContent("@priya-nair-2"));
});

test("Change opens the input with the derived slug, focused", async () => {
  const user = userEvent.setup();
  setup({ initialName: "Priya Nair" });
  const change = screen.getByRole("button", { name: "Change" });
  expect(change.getAttribute("type")).toBe("button");
  await user.click(change);
  const input = screen.getByLabelText("Slug");
  expect(input).toHaveValue("priya-nair");
  expect(input).toHaveFocus();
});

test("once edited the name no longer drives the slug", async () => {
  const user = userEvent.setup();
  setup({ initialName: "Priya" });
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.clear(screen.getByLabelText("Slug"));
  await user.type(screen.getByLabelText("Slug"), "ops");
  await user.type(screen.getByLabelText("Name"), " Nair");
  expect(screen.getByLabelText("Slug")).toHaveValue("ops");
});

test("an empty derivation reads 'choose one'", () => {
  setup({ initialName: "" });
  expect(line()).toHaveTextContent("Address: choose one · Change");
});

test("forceOpen opens the input focused, with its error, and reports it", async () => {
  setup({ initialName: "", forceOpen: true, error: "Pick an address." });
  const input = await screen.findByLabelText("Slug");
  expect(input).toHaveFocus();
  expect(screen.getByText("Pick an address.")).toBeInTheDocument();
  await waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
});

test("forceOpen after the Name blurred moves focus to the slug input", async () => {
  const user = userEvent.setup();
  setup({ initialName: "" });
  await user.click(screen.getByLabelText("Name"));
  await user.tab();
  await user.click(screen.getByRole("button", { name: "Force" }));
  expect(await screen.findByLabelText("Slug")).toHaveFocus();
  expect(opened).toHaveBeenCalledTimes(1);
});

test("forceOpen with the field already open (via Change) refocuses it", async () => {
  const user = userEvent.setup();
  setup({ initialName: "Priya" });
  await user.click(screen.getByRole("button", { name: "Change" }));
  await user.click(screen.getByLabelText("Name"));
  expect(screen.getByLabelText("Name")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Force" }));
  await waitFor(() => expect(screen.getByLabelText("Slug")).toHaveFocus());
  expect(opened).toHaveBeenCalledTimes(1);
});

test("an error opens the field even without forceOpen", () => {
  setup({ initialName: "Priya", error: "That address is taken." });
  expect(screen.getByLabelText("Slug")).toBeInTheDocument();
  expect(screen.getByText("That address is taken.")).toBeInTheDocument();
});

test("the avatar's slug settles after 300ms without typing", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  setup({ initialName: "Priya" });
  const sig = () => document.querySelector("[data-agent-avatar]")?.innerHTML;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });
  const first = sig();
  await user.type(screen.getByLabelText("Name"), "x");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(line()).toHaveTextContent("@priyax");
  expect(sig()).toBe(first);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(sig()).not.toBe(first);
});
