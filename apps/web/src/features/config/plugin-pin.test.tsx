import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json } from "@/test/mock-api";
import {
  LIB,
  lastOf,
  MARKETPLACES,
  PIN,
  PluginsForm,
  pinned,
  useMarketplaces,
} from "@/test/plugins-harness";

beforeEach(() => fakeMatchMedia.install(false));

const withPlugins = (decl: unknown, keys = ["review@acme"]) => ({
  settings: {
    enabledPlugins: Object.fromEntries(keys.map((k) => [k, true])),
    extraKnownMarketplaces: { acme: decl },
  },
});

const group = () => screen.findByRole("group", { name: "acme" });
const changePin = async () => {
  const g = await group();
  await userEvent.click(await within(g).findByRole("button", { name: "Change pin for acme" }));
};

const DIFF = {
  key: "review@acme",
  from: { commit: PIN, present: true, version: "1.2.0", unshown: [] },
  to: { commit: LIB, present: true, version: "1.3.0", unshown: [] },
  diff: {
    hooks: {
      added: [
        {
          event: "PreToolUse",
          matcher: "Bash",
          type: "command",
          command: "./guard.sh",
          timeout: null,
        },
      ],
      removed: [],
    },
    mcp: { added: [], removed: [] },
    commands: { added: [], removed: [] },
    dependencies: { added: [], removed: ["old-dep"] },
    codeParts: { added: [], removed: [] },
    needs: { added: [], removed: [] },
    runsCode: true,
  },
};
const serveDiff = () =>
  useMarketplaces(MARKETPLACES, {
    "POST /api/library/plugins/review%40acme/diff": () => json(DIFF),
  });

describe("pinned by default", () => {
  test("shows the short commit as a copy button and the newer commit Skills read", async () => {
    useMarketplaces();
    render(<PluginsForm start={withPlugins(pinned(PIN))} />);
    const g = await group();
    await waitFor(() => expect(g).toHaveTextContent(/Pinned\s*·\s*a1b2c3d/));
    expect(g).toHaveTextContent(/Newer in Skills:\s*e4f5a6b/);
    expect(within(g).getByRole("button", { name: `Copy commit ${PIN}` })).toBeInTheDocument();
  });

  test("Pin to … reviews the diff in place with focus on its heading, and writes the new ref", async () => {
    const api = serveDiff();
    const onValue = vi.fn();
    render(<PluginsForm start={withPlugins(pinned(PIN))} onValue={onValue} />);
    await changePin();
    await userEvent.click(await screen.findByRole("menuitem", { name: /Pin to e4f5a6b/ }));
    const heading = screen.getByRole("heading", { name: "Pin acme to e4f5a6b" });
    await waitFor(() => expect(heading).toHaveFocus());
    // The diff loads for every plugin the template uses from the marketplace, between the two commits.
    expect(await screen.findByText("Runs code changed")).toBeInTheDocument();
    expect(screen.getByText("PreToolUse (Bash): ./guard.sh")).toBeInTheDocument();
    expect(screen.getByText("dependency old-dep")).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({ from: PIN, to: LIB });
    const primary = screen.getByRole("button", { name: "Pin to e4f5a6b" });
    // The review is inside the group, never a dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      within(await group()).getByRole("group", { name: "Pin acme to e4f5a6b" }),
    ).toBeInTheDocument();
    await userEvent.click(primary);
    expect(lastOf(onValue)).toEqual(withPlugins(pinned(LIB)));
    expect(screen.queryByRole("heading", { name: "Pin acme to e4f5a6b" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change pin for acme" })).toHaveFocus();
  });

  test("the primary waits for the diff", async () => {
    let release = () => {};
    useMarketplaces(MARKETPLACES, {
      "POST /api/library/plugins/review%40acme/diff": () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(DIFF));
        }),
    });
    const onValue = vi.fn();
    render(<PluginsForm start={withPlugins(pinned(PIN))} onValue={onValue} />);
    await changePin();
    await userEvent.click(await screen.findByRole("menuitem", { name: /Pin to e4f5a6b/ }));
    const primary = screen.getByRole("button", { name: "Pin to e4f5a6b" });
    expect(primary).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(primary);
    expect(onValue).not.toHaveBeenCalled();
    release();
    await screen.findByText("Runs code changed");
    expect(primary).not.toHaveAttribute("aria-disabled");
  });

  test("Cancel and Esc close the review and return focus to Change pin", async () => {
    serveDiff();
    render(<PluginsForm start={withPlugins(pinned(PIN))} />);
    await changePin();
    await userEvent.click(await screen.findByRole("menuitem", { name: /Pin to e4f5a6b/ }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("heading", { name: "Pin acme to e4f5a6b" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change pin for acme" })).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Change pin for acme" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Pin to e4f5a6b/ }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Pin acme to e4f5a6b" })).toHaveFocus(),
    );
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("heading", { name: "Pin acme to e4f5a6b" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change pin for acme" })).toHaveFocus();
  });

  test("a diff that fails says so and can retry", async () => {
    let fail = true;
    useMarketplaces(MARKETPLACES, {
      "POST /api/library/plugins/review%40acme/diff": () =>
        fail ? json({ error: { code: "x", message: "x" } }, 500) : json(DIFF),
    });
    render(<PluginsForm start={withPlugins(pinned(PIN))} />);
    await changePin();
    await userEvent.click(await screen.findByRole("menuitem", { name: /Pin to e4f5a6b/ }));
    expect(await screen.findByText("Couldn't load what changes.")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Runs code changed")).toBeInTheDocument();
    // A retry isn't a menu selection: a later Esc on the menu still returns focus to its trigger.
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Change pin for acme" }));
    await screen.findByRole("menuitem", { name: /Pin to e4f5a6b/ });
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change pin for acme" })).toHaveFocus(),
    );
  });
});

describe("Latest is explicit", () => {
  test("Use Latest, auto-update… shows its risk and removes the ref on Use Latest", async () => {
    useMarketplaces();
    const onValue = vi.fn();
    render(<PluginsForm start={withPlugins(pinned(PIN))} onValue={onValue} />);
    await changePin();
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Use Latest, auto-update…" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Use Latest for acme" })).toHaveFocus(),
    );
    expect(
      screen.getByText(
        "Latest runs acme's newest code at each restart, without review, with each agent's workspace and credentials in reach.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Use Latest" }));
    expect(lastOf(onValue)).toEqual(withPlugins(pinned()));
    expect(screen.getByRole("button", { name: "Change pin for acme" })).toHaveFocus();
    // The badge's words, and nothing says Pinned any more.
    const g = await group();
    expect(within(g).getByText("Latest")).toBeInTheDocument();
    expect(within(g).getByText("auto-updates")).toBeInTheDocument();
    expect(g).not.toHaveTextContent("Pinned");
  });

  test("from Latest, Pin to … offers the Library's commit with no diff to compare", async () => {
    const api = useMarketplaces();
    const onValue = vi.fn();
    render(<PluginsForm start={withPlugins(pinned())} onValue={onValue} />);
    await changePin();
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pin to e4f5a6b…" }));
    expect(screen.queryByRole("menuitem", { name: /Use Latest/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Pin to e4f5a6b" }));
    expect(lastOf(onValue)).toEqual(withPlugins(pinned(LIB)));
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("a pin already at the Library's commit only offers Latest", async () => {
    useMarketplaces();
    render(<PluginsForm start={withPlugins(pinned(LIB))} />);
    await changePin();
    expect(screen.getByRole("menuitem", { name: "Use Latest, auto-update…" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Pin to/ })).toBeNull();
  });
});

describe("folders and agents", () => {
  test("a folder marketplace reads 'Local folder, live' and has no Change pin", async () => {
    useMarketplaces();
    render(
      <PluginsForm
        start={{
          settings: {
            enabledPlugins: { "local@mine": true },
            extraKnownMarketplaces: {
              mine: { source: { source: "directory", path: "/home/me/plugins" } },
            },
          },
        }}
      />,
    );
    const g = await screen.findByRole("group", { name: "mine" });
    expect(g).toHaveTextContent("Local folder, live");
    expect(within(g).queryByRole("button", { name: /Change pin/ })).toBeNull();
    expect(within(g).queryByText("auto-updates")).toBeNull();
  });
});
