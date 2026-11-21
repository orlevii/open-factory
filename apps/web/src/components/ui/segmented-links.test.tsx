import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { SegmentedLinks } from "./segmented-links";

function renderAt(path: string) {
  const root = createRootRoute({
    component: () => (
      <>
        <SegmentedLinks
          label="Templates views"
          items={[
            { to: "/templates", label: "Templates" },
            { to: "/templates/images", label: "Images" },
          ]}
        />
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/templates" }),
      createRoute({ getParentRoute: () => root, path: "/templates/images" }),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

test("two plain links in a labelled nav; only the current one has aria-current=page; no radios", async () => {
  renderAt("/templates/images");
  const nav = await screen.findByRole("navigation", { name: "Templates views" });
  const links = within(nav).getAllByRole("link");
  expect(links.map((l) => l.textContent)).toEqual(["Templates", "Images"]);
  // Exact matching: /templates is not "current" on /templates/images.
  expect(within(nav).getByRole("link", { name: "Images" })).toHaveAttribute("aria-current", "page");
  expect(within(nav).getByRole("link", { name: "Templates" })).not.toHaveAttribute("aria-current");
  expect(within(nav).getByRole("link", { name: "Templates" })).toHaveAttribute("href", "/templates");
  expect(screen.queryAllByRole("radio")).toEqual([]);
  expect(screen.queryAllByRole("radiogroup")).toEqual([]);
});

test("Tab moves between the links (no roving focus), and clicking one makes it current", async () => {
  const router = renderAt("/templates");
  const nav = await screen.findByRole("navigation", { name: "Templates views" });
  await userEvent.tab();
  expect(within(nav).getByRole("link", { name: "Templates" })).toHaveFocus();
  await userEvent.tab();
  expect(within(nav).getByRole("link", { name: "Images" })).toHaveFocus();
  await userEvent.click(within(nav).getByRole("link", { name: "Images" }));
  await screen.findByRole("link", { name: "Images", current: "page" });
  expect(router.state.location.pathname).toBe("/templates/images");
});

test("the SegmentedControl look: a track holding the segments; the current one marked by aria-current", async () => {
  renderAt("/templates");
  const nav = await screen.findByRole("navigation", { name: "Templates views" });
  const track = nav.querySelector("[data-slot=segmented-track]");
  expect(track).not.toBeNull();
  for (const l of within(nav).getAllByRole("link")) {
    expect(l).toHaveClass("h-full", "border");
    expect(l.className).toMatch(/aria-\[current=page\]:/);
  }
});
