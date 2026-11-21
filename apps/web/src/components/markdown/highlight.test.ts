import { afterEach, describe, expect, test, vi } from "vitest";
import { highlight, resolveLang } from "./highlight";

test("resolves fence aliases to grammars and rejects unknown languages", () => {
  expect(resolveLang("ts")).toBe("typescript");
  expect(resolveLang("Bash")).toBe("shellscript");
  expect(resolveLang("nope")).toBeUndefined();
});

test("highlights with the JavaScript regex engine and both themes", async () => {
  const html = await highlight("const a = 1;", "ts");
  expect(html).toContain('class="shiki shiki-themes github-light github-dark"');
  expect(html).toContain("--shiki-dark");
  expect(await highlight("x", "nope")).toBeNull();
});

describe("resolveLang", () => {
  test("console is a shell session, not a script", () => {
    expect(resolveLang("console")).toBe("shellsession");
  });
  test.each([
    ["ps1", "powershell"],
    ["powershell", "powershell"],
    ["hcl", "hcl"],
    ["terraform", "hcl"],
    ["proto", "proto"],
    ["env", "dotenv"],
  ])("%s resolves to %s and highlights", async (alias, id) => {
    expect(resolveLang(alias)).toBe(id);
    expect(await highlight("x", alias)).toContain("shiki");
  });
});

describe("a failed highlighter load", () => {
  afterEach(() => {
    vi.doUnmock("shiki/core");
    vi.resetModules();
  });
  test("rejects once, then the next call retries", async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("shiki/core")>("shiki/core");
    let calls = 0;
    vi.doMock("shiki/core", () => ({
      ...actual,
      createHighlighterCore: (...args: Parameters<typeof actual.createHighlighterCore>) => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error("chunk"))
          : actual.createHighlighterCore(...args);
      },
    }));
    const fresh = await import("./highlight");
    await expect(fresh.highlight("x", "ts")).rejects.toThrow("chunk");
    expect(await fresh.highlight("x", "ts")).toContain("shiki");
    expect(calls).toBe(2);
  });
});
