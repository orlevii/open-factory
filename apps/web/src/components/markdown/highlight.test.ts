import { afterEach, describe, expect, test, vi } from "vitest";
import { highlight, highlightFile, langForPath, resolveLang } from "./highlight";

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

describe("langForPath", () => {
  test.each([
    ["/a/retry.ts", "typescript"],
    ["src/App.TSX", "tsx"],
    ["x.mjs", "javascript"],
    ["main.py", "python"],
    ["lib.rs", "rust"],
    ["deploy.yml", "yaml"],
    ["infra/main.tf", "hcl"],
    ["page.htm", "html"],
    ["/repo/Dockerfile", "dockerfile"],
    ["Makefile", "make"],
    ["/app/.env", "dotenv"],
    ["/app/.env.local", "dotenv"],
    ["run.zsh", "shellscript"],
  ])("%s → %s", (path, id) => {
    expect(langForPath(path)).toBe(id);
  });
  test.each([["notes.txt"], ["README"], ["/a/b/"], ["data.weird"], [""]])(
    "%s has no grammar (plain)",
    (path) => {
      expect(langForPath(path)).toBeUndefined();
    },
  );
});

describe("highlightFile", () => {
  test("tokens per line, coloured for both themes", async () => {
    const lines = await highlightFile("const a = 1;\nlet b", "/a.ts");
    expect(lines).toHaveLength(2);
    expect(lines?.[0]?.map((t) => t.content).join("")).toBe("const a = 1;");
    expect(lines?.[0]?.[0]?.style).toMatchObject({ color: expect.any(String) });
    expect(lines?.[0]?.[0]?.style?.["--shiki-dark"]).toEqual(expect.any(String));
  });
  test("an unknown extension stays plain", async () => {
    expect(await highlightFile("x", "notes.txt")).toBeNull();
  });
  test("above 2,000 lines stays plain", async () => {
    expect(await highlightFile("x\n".repeat(2000), "/a.ts")).not.toBeNull();
    expect(await highlightFile("x\n".repeat(2001), "/a.ts")).toBeNull();
  });
});
