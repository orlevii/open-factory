import {
  type AnyRouter,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { sheetRedirect } from "@/features/sheets/redirect";
import { getSheetState, resetSheets } from "@/features/sheets/sheet-store";

beforeEach(() => resetSheets());

function makeRouter(initial: string) {
  const root = createRootRoute();
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => null });
  let router!: AnyRouter;
  const form = createRoute({
    getParentRoute: () => root,
    path: "/to-form",
    beforeLoad: ({ preload }) => sheetRedirect({ kind: "new-task" }, "/to", { preload, router }),
  });
  router = createRouter({
    routeTree: root.addChildren([stub("/from"), stub("/to"), form]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  return router;
}

test("navigating to the form URL lands on the page with the sheet open, replacing history", async () => {
  const router = makeRouter("/from");
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await router.navigate({ to: "/to-form" as "/" });
  expect(router.state.location.pathname).toBe("/to");
  expect(getSheetState().parent).toMatchObject({ kind: "new-task", at: "/to", instant: false });
  router.history.back();
  await waitFor(() => expect(router.state.location.pathname).toBe("/from"));
});

test("a fresh load opens the sheet instantly", async () => {
  const router = makeRouter("/to-form");
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.location.pathname).toBe("/to"));
  expect(getSheetState().parent).toMatchObject({ kind: "new-task", at: "/to", instant: true });
  expect(router.history.canGoBack()).toBe(false);
});

test("a preload opens nothing", async () => {
  const router = makeRouter("/from");
  render(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.status).toBe("idle"));
  await router.preloadRoute({ to: "/to-form" as "/" });
  expect(getSheetState().parent).toBeUndefined();
  expect(router.state.location.pathname).toBe("/from");
});
