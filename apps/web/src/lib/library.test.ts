import { QueryClient } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/components/ui/toaster";
import { fakeMatchMedia } from "@/test/fake-match-media";
import { json, mockApi } from "@/test/mock-api";
import {
  invalidateLibrary,
  libraryQueryOptions,
  onLibraryChanged,
  resetLibraryChanged,
  selectSourceGroup,
  skillQueryOptions,
  sourceQueryOptions,
} from "./library";

beforeEach(() => {
  vi.useFakeTimers();
  fakeMatchMedia.install(false);
});
afterEach(() => {
  resetLibraryChanged();
  act(() => {
    toast.dismiss();
  });
  vi.useRealTimers();
});

const frame = { type: "library_changed" } as const;

test("ten frames in one tick refetch the library once, when the window ends", () => {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  for (let i = 0; i < 10; i++) onLibraryChanged(qc, frame);
  expect(invalidate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(249);
  expect(invalidate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["library"] });
});

test("a config change and a library frame in one tick share one refetch", () => {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  invalidateLibrary(qc);
  onLibraryChanged(qc, frame);
  invalidateLibrary(qc);
  vi.advanceTimersByTime(250);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["library"] });
});

test("a frame after the window opens a new one", () => {
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  onLibraryChanged(qc, frame);
  vi.advanceTimersByTime(250);
  onLibraryChanged(qc, frame);
  vi.advanceTimersByTime(250);
  expect(invalidate).toHaveBeenCalledTimes(2);
});

test("a failed background add is a toast at once, even inside a coalesced window", () => {
  const qc = new QueryClient();
  vi.spyOn(qc, "invalidateQueries").mockResolvedValue();
  render(createElement(Toaster));
  onLibraryChanged(qc, frame);
  act(() => onLibraryChanged(qc, { ...frame, addFailed: "acme/skills" }));
  act(() => vi.advanceTimersByTime(20));
  expect(screen.getByText("Couldn't add acme/skills.")).toBeInTheDocument();
});

test("the queries fetch their endpoints, with group and name encoded", async () => {
  const api = mockApi({
    "GET /api/library/skills": () => json({ hostDir: "/s", groups: [] }),
    "GET /api/library/skills/source%3As1/tdd": () =>
      json({
        group: "source:s1",
        name: "tdd",
        description: "",
        state: "ok",
        usedBy: { templates: 0, agents: 0 },
        files: [],
        hooks: [],
        usedByTemplates: [],
        skillMd: "",
      }),
  });
  const qc = new QueryClient();
  expect(await qc.fetchQuery(libraryQueryOptions)).toEqual({ hostDir: "/s", groups: [] });
  expect((await qc.fetchQuery(skillQueryOptions("source:s1", "tdd"))).name).toBe("tdd");
  expect(api.calls.map((c) => c.url)).toEqual([
    "/api/library/skills",
    "/api/library/skills/source%3As1/tdd",
  ]);
});

test("one invalidation of the library prefix reaches the list, a skill and a source", async () => {
  mockApi({
    "GET /api/library/skills": () => json({ hostDir: "/s", groups: [] }),
    "GET /api/library/skills/host/tdd": () =>
      json({
        group: "host",
        name: "tdd",
        description: "",
        state: "ok",
        usedBy: { templates: 0, agents: 0 },
        files: [],
        hooks: [],
        usedByTemplates: [],
        skillMd: "",
      }),
    "GET /api/library/sources/s1": () =>
      json({
        id: "s1",
        kind: "folder",
        path: "/x",
        repo: null,
        subpath: null,
        branch: null,
        pin: null,
        committedAt: null,
        subject: null,
        state: "ready",
        skills: [],
        updateCommit: null,
        updateAt: null,
        updateSubject: null,
        checkedAt: null,
        checkError: null,
        usedBy: { templates: 0, agents: 0 },
        update: null,
      }),
  });
  const qc = new QueryClient();
  const skill = skillQueryOptions("host", "tdd");
  const source = sourceQueryOptions("s1");
  await qc.fetchQuery(libraryQueryOptions);
  await qc.fetchQuery(skill);
  await qc.fetchQuery(source);
  const isInvalidated = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;
  const invalidated = () => [
    isInvalidated(libraryQueryOptions.queryKey),
    isInvalidated(skill.queryKey),
    isInvalidated(source.queryKey),
  ];
  expect(invalidated()).toEqual([false, false, false]);
  await qc.invalidateQueries({ queryKey: ["library"], refetchType: "none" });
  expect(invalidated()).toEqual([true, true, true]);
});

test("a select is the same function for the same key, and the cache is bounded", () => {
  const first = selectSourceGroup("s0");
  expect(selectSourceGroup("s0")).toBe(first);
  // Well past the cap: the oldest keys are dropped, so the first one is rebuilt rather than kept forever...
  for (let i = 1; i <= 300; i++) selectSourceGroup(`s${i}`);
  expect(selectSourceGroup("s0")).not.toBe(first);
  // ...while a recent one is still the same function.
  const recent = selectSourceGroup("s300");
  expect(selectSourceGroup("s300")).toBe(recent);
  // The rebuilt select still answers.
  expect(first({ hostDir: "/h", groups: [] })).toBeUndefined();
});
