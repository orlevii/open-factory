import { expect, test } from "vitest";
import {
  checkName,
  checkUrl,
  fromDraft,
  isFormShaped,
  pairErrors,
  serverSummary,
  toDraft,
} from "./mcp-entry";
import { CONFIG_FIELD_MSG } from "./messages";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

test("a command row reads the program and the argument count, never the arguments", () => {
  const s = serverSummary({ command: "npx", args: ["-y", "@acme/mcp", `--token=${TOKEN}`] });
  expect(s).toBe("npx · 3 args");
  expect(serverSummary({ command: "/usr/local/bin/uvx", args: ["x"] })).toBe("uvx · 1 arg");
  expect(serverSummary({ command: "node" })).toBe("node");
});

test("a command that isn't a bare program name reads 'Command'", () => {
  const s = serverSummary({ command: `run --key sk-ant-api03-${TOKEN}`, args: [] });
  expect(s).toBe("Command");
  expect(s).not.toContain("sk-ant");
});

test("a URL row reads the host only: no userinfo, path or query", () => {
  const s = serverSummary({
    type: "http",
    url: `https://user:${TOKEN}@mcp.acme.dev/v1?key=${TOKEN}`,
  });
  expect(s).toBe("mcp.acme.dev");
  expect(serverSummary({ type: "http", url: `https://\${HOST}/mcp` })).toBe("URL not shown");
});

test("the draft keeps unknown keys and drops the other kind's fields on save", () => {
  const d = toDraft("gh", { command: "npx", args: ["a", "b"], env: { T: `\${GH}` }, timeout: 5 });
  expect(d.kind).toBe("command");
  const asUrl = { ...d, kind: "url" as const, url: "https://x.dev/mcp" };
  expect(fromDraft(asUrl)).toEqual({ timeout: 5, type: "http", url: "https://x.dev/mcp" });
  expect(fromDraft(d)).toEqual({
    timeout: 5,
    command: "npx",
    args: ["a", "b"],
    env: { T: `\${GH}` },
  });
});

test("blank pairs and blank argument lines are dropped", () => {
  const d = toDraft("x", { command: "npx" });
  d.args = "a\n\nb\n";
  d.env = [{ id: 1, name: "", value: "" }];
  expect(fromDraft(d)).toEqual({ command: "npx", args: ["a", "b"] });
});

test("names, URLs and pairs are checked", () => {
  expect(checkName(" ", new Set())).toBe(CONFIG_FIELD_MSG.enterName);
  expect(checkName("factory", new Set())).toBe(CONFIG_FIELD_MSG.factoryServer);
  expect(checkName("gh", new Set(["gh"]))).toBe(CONFIG_FIELD_MSG.duplicate);
  expect(checkUrl("ftp://x")).toBe(CONFIG_FIELD_MSG.urlScheme);
  expect(checkUrl(`https://\${HOST}/mcp`)).toBeUndefined();
  const errs = pairErrors("env", [
    { id: 1, name: "A-B", value: "" },
    { id: 2, name: "OK", value: "" },
    { id: 3, name: "OK", value: "" },
    { id: 4, name: "", value: "" },
  ]);
  expect([...errs]).toEqual([
    [1, CONFIG_FIELD_MSG.envName],
    [3, CONFIG_FIELD_MSG.duplicate],
  ]);
});

test("an entry with wrongly typed parts isn't form-shaped", () => {
  expect(isFormShaped({ command: "npx", args: "a b" })).toBe(false);
  expect(isFormShaped({ url: "https://x", headers: { A: 1 } })).toBe(false);
  expect(isFormShaped("npx")).toBe(false);
  expect(isFormShaped({ command: "npx", args: ["a"] })).toBe(true);
});

test("a token pasted as a bare command never shows, by prefix or by length", () => {
  for (const command of [
    "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    "gho_short",
    "sk-ant-x",
    "github_pat_11ABC",
    "xoxb-123",
    "a".repeat(33),
  ])
    expect(serverSummary({ command }), command).toBe("Command");
  expect(serverSummary({ command: "a".repeat(32) })).toBe("a".repeat(32));
});

test("a URL entry keeps its own transport type on save, except stdio", () => {
  const d = toDraft("x", { type: "streamable-http", url: "https://x.dev" });
  expect(fromDraft(d)).toEqual({ type: "streamable-http", url: "https://x.dev" });
  const sse = toDraft("x", { type: "sse", url: "https://x.dev" });
  expect(fromDraft(sse).type).toBe("sse");
  const was = toDraft("x", { type: "stdio", command: "npx" });
  expect(fromDraft({ ...was, kind: "url", url: "https://x.dev" }).type).toBe("http");
});
