import { expect, test } from "vitest";
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
