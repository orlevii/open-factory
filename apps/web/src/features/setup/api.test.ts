import { focusManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { json, mockApi } from "@/test/mock-api";
import { setupQueryOptions } from "./api";

const none = { hasCredential: false, hasTemplate: false, hasAgent: false };
const withAgent = { hasCredential: true, hasTemplate: true, hasAgent: true };

// The provider mounts the client, which wires window focus to the cache; a test does the same.
let qc: QueryClient | undefined;
function client() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.mount();
  return qc;
}
afterEach(() => {
  qc?.unmount();
  qc = undefined;
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("the setup query reads GET /api/setup", async () => {
  mockApi({ "GET /api/setup": () => json(none) });
  await expect(client().fetchQuery(setupQueryOptions)).resolves.toEqual(none);
});

test("before an agent exists, a window focus after 30 s refetches the answer", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let answer = none;
  const api = mockApi({ "GET /api/setup": () => json(answer) });
  const observer = new QueryObserver(client(), setupQueryOptions);
  const stop = observer.subscribe(() => {});
  await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(none));
  answer = { ...none, hasCredential: true };
  vi.setSystemTime(Date.now() + 31_000);
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await vi.waitFor(() =>
    expect(observer.getCurrentResult().data).toEqual({ ...none, hasCredential: true }),
  );
  expect(api.calls.filter((c) => c.url === "/api/setup")).toHaveLength(2);
  stop();
});

test("once an agent exists, a window focus does not refetch the answer", async () => {
  const api = mockApi({ "GET /api/setup": () => json(withAgent) });
  const c = client();
  c.setQueryData(setupQueryOptions.queryKey, withAgent);
  const observer = new QueryObserver(c, setupQueryOptions);
  const stop = observer.subscribe(() => {});
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await new Promise((r) => setTimeout(r, 20));
  expect(api.calls).toHaveLength(0);
  expect(observer.getCurrentResult().data).toEqual(withAgent);
  stop();
});
