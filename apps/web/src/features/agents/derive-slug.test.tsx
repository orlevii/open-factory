import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, test, vi } from "vitest";
import { deriveSlug, foldLetters, useTakenNames } from "./derive-slug";

const lists = vi.hoisted(() => ({
  exclude: Promise.resolve([{ handle: "alice" }]),
  only: Promise.resolve([{ handle: "old-bot" }]),
  users: Promise.resolve([{ handle: "priya" }]),
  gate: { exclude: false, only: false, users: false },
}));
const gated = <T,>(k: "exclude" | "only" | "users", v: () => T) =>
  new Promise<T>((res) => {
    const tick = () => (lists.gate[k] ? res(v()) : setTimeout(tick, 5));
    tick();
  });
vi.mock("@/features/agents/api", () => ({
  agentsListQueryOptions: (m: "exclude" | "only") => ({
    queryKey: ["agents", m],
    queryFn: () =>
      gated(m, () => (m === "exclude" ? [{ handle: "alice" }] : [{ handle: "old-bot" }])),
  }),
}));
vi.mock("@/features/settings/api", () => ({
  usersQueryOptions: {
    queryKey: ["users"],
    queryFn: () => gated("users", () => [{ handle: "priya" }]),
  },
}));

const none = new Set<string>();

describe("deriveSlug", () => {
  test.each([
    ["Priya Nair", "priya-nair"],
    ["Łukasz Żak", "lukasz-zak"],
    ["Søren Lund", "soren-lund"],
    ["Straße", "strasse"],
    ["Æther Œuvre", "aether-oeuvre"],
    ["Đorđe", "dorde"],
    ["Iğdır ı", "igdir-i"],
    ["Þór", "thor"],
    ["  --Ops!!  Lead-- ", "ops-lead"],
    ["陳大文", ""],
    ["🤖", ""],
    ["9lives", ""],
  ])("%s → %s", (n, s) => expect(deriveSlug(n, none)).toBe(s));

  test("taken names get -2, -3", () => {
    expect(deriveSlug("Priya Nair", new Set(["priya-nair"]))).toBe("priya-nair-2");
    expect(deriveSlug("Priya Nair", new Set(["priya-nair", "priya-nair-2"]))).toBe("priya-nair-3");
  });

  test("a 40-char base is cut so the suffix fits, never '--2'", () => {
    const name = "abcdefghij abcdefghij abcdefghij abcdefgh";
    const base = deriveSlug(name, none);
    expect(base.length).toBe(40);
    const s = deriveSlug(name, new Set([base]));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).not.toMatch(/--/);
    expect(s.endsWith("-2")).toBe(true);
  });

  test("a base ending in a hyphen at the cut gets no '--2'", () => {
    const name = `${"a".repeat(37)} bcd`; // 37 letters, then a hyphen as the 38th character
    const base = deriveSlug(name, none);
    expect(base.length).toBe(40);
    const s = deriveSlug(name, new Set([base]));
    expect(s).toBe(`${"a".repeat(37)}-2`);
    expect(s).not.toMatch(/--/);
  });
});

test("foldLetters folds what NFKD leaves alone", () => {
  expect(foldLetters("Łø ß")).toBe("Lo ss");
});

test("foldLetters folds capital sharp S", () => {
  expect(foldLetters("STRAẞE")).toBe("STRASsE");
  expect(deriveSlug("STRAẞE", none)).toBe("strasse");
});

describe("useTakenNames", () => {
  test("undefined until all three lists answer; then the union, one Set across rerenders", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(() => useTakenNames(true), { wrapper });
    expect(result.current).toBeUndefined();
    lists.gate.exclude = true;
    lists.gate.only = true;
    await new Promise((r) => setTimeout(r, 40));
    expect(result.current).toBeUndefined();
    lists.gate.users = true;
    await waitFor(() => expect(result.current).toBeDefined());
    const set = result.current;
    for (const n of ["alice", "old-bot", "priya", "me"]) expect(set?.has(n)).toBe(true);
    rerender();
    expect(result.current).toBe(set);
  });
});
