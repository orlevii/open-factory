import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { principal } from "@/test/chat-fixtures";
import { refFor } from "@/test/refs";
import { applyPrincipalUpdated, mergePrincipals, principalsQueryOptions } from "./api";

afterEach(() => vi.unstubAllGlobals());

test.each([
  ["projects", ["projects"]],
  ["templates", ["templates", "dev"]],
  ["library", ["library", "skills"]],
])("a rename refetches %s, whose rows name agents by handle", (_name, key) => {
  const qc = new QueryClient();
  qc.setQueryData(key, []);
  applyPrincipalUpdated(qc, principal(refFor("dev"), "builder"));
  expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
});

test("a principal_updated that arrives while the principals are still loading is not lost", async () => {
  const lists = [
    [principal(refFor("dev"), "dev")], // read before the rename
    [principal(refFor("dev"), "builder")],
  ];
  const answer = (principals: unknown[]) =>
    new Response(JSON.stringify({ principals }), {
      headers: { "content-type": "application/json" },
    });
  let release: (r: Response) => void = () => {};
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)))
    .mockImplementationOnce(() => Promise.resolve(answer(lists[1] as unknown[])));
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient();
  const watch = new QueryObserver(qc, principalsQueryOptions).subscribe(() => {});
  try {
    mergePrincipals(qc, [principal(refFor("dev"), "builder")]);
    release(answer(lists[0] as unknown[]));
    await vi.waitFor(() =>
      expect(
        qc
          .getQueryData<{ byRef: Map<string, { handle: string }> }>(["principals"])
          ?.byRef.get(refFor("dev"))?.handle,
      ).toBe("builder"),
    );
  } finally {
    watch();
  }
});
