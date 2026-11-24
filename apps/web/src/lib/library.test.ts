import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { libraryQueryOptions, skillQueryOptions, sourceQueryOptions } from "./library";

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
