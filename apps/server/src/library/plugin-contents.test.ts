// biome-ignore-all lint/suspicious/noTemplateCurlyInString: plugin files reference paths and secrets as ${NAME}.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { diffContents, readContents } from "./plugin-contents.ts";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A fresh plugin checkout with the given files (relative path → text). A file that starts with `#!` is a script and gets the exec bit. */
function plugin(files: Record<string, string> = {}): string {
  const base = mkdtempSync(path.join(tmpdir(), "of-plugin-"));
  roots.push(base);
  const root = path.join(base, "plugin");
  mkdirSync(root);
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text, { mode: text.startsWith("#!") ? 0o755 : 0o644 });
  }
  return root;
}

const json = (value: unknown) => JSON.stringify(value);

describe("readContents: what the plugin runs", () => {
  test("reads hooks from hooks/hooks.json with event, matcher, type, command and timeout", async () => {
    const root = plugin({
      "hooks/hooks.json": json({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "node ./check.js --strict", timeout: 10 }],
            },
          ],
          SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    });
    const c = await readContents(root);
    expect(c.hooks).toEqual([
      {
        event: "PreToolUse",
        matcher: "Bash",
        type: "command",
        command: "node ./check.js --strict",
        timeout: 10,
      },
      { event: "SessionStart", matcher: "", type: "command", command: "echo hi", timeout: null },
    ]);
  });

  test("reads hooks inline in plugin.json and by path, in addition to hooks/hooks.json", async () => {
    const root = plugin({
      ".claude-plugin/plugin.json": json({
        name: "p",
        hooks: "./config/hooks.json",
      }),
      "config/hooks.json": json({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "bash ./stop.sh" }] }] },
      }),
    });
    const inline = plugin({
      ".claude-plugin/plugin.json": json({
        name: "q",
        hooks: { Notification: [{ hooks: [{ type: "command", command: "say done" }] }] },
      }),
    });
    expect((await readContents(root)).hooks.map((h) => h.event)).toEqual(["Stop"]);
    expect((await readContents(inline)).hooks.map((h) => h.command)).toEqual(["say done"]);
  });

  test("shows stdio servers with their command, args and env, hiding ${…} references", async () => {
    const root = plugin({
      ".mcp.json": json({
        mcpServers: {
          local: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/server.js", "--port", "9"],
            env: {
              NODE_OPTIONS: "--require ./preload.js",
              API_KEY: "${USER_API_KEY}",
            },
          },
        },
      }),
    });
    const [server] = (await readContents(root)).mcp;
    expect(server).toEqual({
      name: "local",
      kind: "stdio",
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/server.js", "--port", "9"],
      env: [
        { name: "NODE_OPTIONS", value: "--require ./preload.js" },
        { name: "API_KEY", value: null },
      ],
      url: null,
      headers: [],
    });
  });

  test("shows http servers with their URL and header names only", async () => {
    const root = plugin({
      ".claude-plugin/plugin.json": json({
        name: "p",
        mcpServers: {
          remote: {
            type: "http",
            url: "https://mcp.example.test/v1",
            headers: { Authorization: "Bearer secret-value", "X-Team": "ops" },
          },
        },
      }),
    });
    const [server] = (await readContents(root)).mcp;
    expect(server).toMatchObject({
      name: "remote",
      kind: "http",
      url: "https://mcp.example.test/v1",
      headers: ["Authorization", "X-Team"],
    });
    expect(JSON.stringify(server)).not.toContain("secret-value");
  });

  test("finds the other code-running parts: LSP, status line, monitors, bin and package.json", async () => {
    const root = plugin({
      ".lsp.json": json({ ts: { command: "typescript-language-server", args: ["--stdio"] } }),
      "monitors/monitors.json": json([{ name: "watch", command: "tail -f log.txt" }]),
      "bin/tool": "#!/bin/sh\n",
      "package.json": json({ name: "p" }),
      ".claude-plugin/plugin.json": json({
        name: "p",
        statusLine: { type: "command", command: "git-status --short" },
      }),
    });
    const c = await readContents(root);
    expect(c.codeParts).toEqual([
      { kind: "lsp", items: ["ts: typescript-language-server --stdio"] },
      { kind: "statusLine", items: ["git-status --short"] },
      { kind: "monitors", items: ["tail -f log.txt"] },
      { kind: "bin", items: ["bin/tool"] },
      { kind: "node", items: ["package.json"] },
    ]);
  });

  test("does not show a bin file without the exec bit as code", async () => {
    const root = plugin({ "bin/readme.txt": "notes\n" });
    expect((await readContents(root)).codeParts).toEqual([]);
  });
});

describe("readContents: needs from the image", () => {
  test.each<{ name: string; files: Record<string, string>; needs: string[] }>([
    {
      name: "a hook's first word",
      files: {
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "command", command: "npx -y x" }] }] },
        }),
      },
      needs: ["npx"],
    },
    {
      name: "the program of a bash -c script",
      files: {
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "command", command: 'bash -c "uvx tool"' }] }] },
        }),
      },
      needs: ["uvx"],
    },
    {
      name: "a stdio MCP server's command",
      files: { ".mcp.json": json({ mcpServers: { s: { command: "bun", args: ["run"] } } }) },
      needs: ["bun"],
    },
    {
      name: "node for a package.json",
      files: { "package.json": json({ name: "p" }) },
      needs: ["node"],
    },
    {
      name: "nothing for a plugin's own script",
      files: {
        "hooks/hooks.json": json({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/scripts/x.sh" }] }],
          },
        }),
      },
      needs: [],
    },
    {
      name: "nothing for the words of a prompt hook",
      files: {
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "Review the diff" }] }] },
        }),
      },
      needs: [],
    },
    {
      name: "the programs of shell keywords, skipping the keywords",
      files: {
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "command", command: "if uvx x; then npx y; fi" }] }] },
        }),
      },
      needs: ["npx", "uvx"],
    },
    {
      name: "the program after env and its assignments",
      files: {
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "command", command: "env FOO=1 node s.js" }] }] },
        }),
      },
      needs: ["node"],
    },
    {
      name: "the program of a /bin/bash -lc script",
      files: {
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "command", command: '/bin/bash -lc "bun run x"' }] }] },
        }),
      },
      needs: ["bun"],
    },
    {
      name: "the program of an sh -c script",
      files: {
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "command", command: 'sh -c "npx -y y"' }] }] },
        }),
      },
      needs: ["npx"],
    },
    {
      name: "the program inside a $( ) substitution",
      files: {
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "command", command: "echo $(uvx --version)" }] }] },
        }),
      },
      needs: ["uvx"],
    },
    {
      name: "the program of an LSP server",
      files: { ".lsp.json": json({ ts: { command: "typescript-language-server" } }) },
      needs: ["typescript-language-server"],
    },
    {
      name: "the program of a status line",
      files: {
        ".claude-plugin/plugin.json": json({
          name: "p",
          statusLine: { command: "git-status --short" },
        }),
      },
      needs: ["git-status"],
    },
    {
      name: "the program of a monitor",
      files: { "monitors/monitors.json": json([{ name: "w", command: "tail -f log.txt" }]) },
      needs: ["tail"],
    },
  ])("lists $name", async ({ files, needs }) => {
    const c = await readContents(plugin(files));
    expect(c.needs).toEqual(needs);
  });

  test("lists the executables of bin/ as a need", async () => {
    const c = await readContents(plugin({ "bin/tool": "#!/bin/sh\n" }));
    expect(c.needs).toEqual(["bin/"]);
  });
});

describe("readContents: what it can't show", () => {
  test("lists a hooks file that is a link, without following it", async () => {
    const outside = plugin({ "hooks.json": json({ hooks: { Stop: [] } }) });
    const root = plugin({});
    mkdirSync(path.join(root, "hooks"));
    symlinkSync(path.join(outside, "hooks.json"), path.join(root, "hooks", "hooks.json"));
    const c = await readContents(root);
    expect(c.hooks).toEqual([]);
    expect(c.unshown).toEqual(["hooks/hooks.json (a link)"]);
  });

  test("lists a hooks file that is not a regular file, such as a FIFO, without opening it", async () => {
    const root = plugin({});
    mkdirSync(path.join(root, "hooks"));
    execFileSync("mkfifo", [path.join(root, "hooks", "hooks.json")]);
    expect((await readContents(root)).unshown).toEqual(["hooks/hooks.json (not a file)"]);
  });

  test("lists JSON over the size cap", async () => {
    const big = json({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "x".repeat(300 * 1024) }] }] },
    });
    const root = plugin({ "hooks/hooks.json": big });
    const c = await readContents(root);
    expect(c.hooks).toEqual([]);
    expect(c.unshown).toEqual(["hooks/hooks.json (over 256 KB)"]);
  });

  test("lists JSON that doesn't parse", async () => {
    const root = plugin({ "hooks/hooks.json": "{ not json" });
    expect((await readContents(root)).unshown).toEqual(["hooks/hooks.json (not valid JSON)"]);
  });

  test("lists the walk when it stops at 2,000 files", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2001; i++) files[`docs/f${i}.txt`] = "x";
    const c = await readContents(plugin(files));
    expect(c.unshown).toEqual(["a walk stopped at 2,000 files"]);
  });

  test("lists a plugin.json key it doesn't know", async () => {
    const root = plugin({ ".claude-plugin/plugin.json": json({ name: "p", fancy: true }) });
    expect((await readContents(root)).unshown).toEqual(['plugin.json key "fancy"']);
  });

  test("lists nothing for a plugin that runs no code", async () => {
    const root = plugin({
      ".claude-plugin/plugin.json": json({ name: "p" }),
      "skills/a/SKILL.md": "---\nname: a\n---\n",
    });
    const c = await readContents(root);
    expect(c.unshown).toEqual([]);
    expect(c.hooks).toEqual([]);
    expect(c.mcp).toEqual([]);
    expect(c.codeParts).toEqual([]);
  });
});

describe("readContents: declared paths, shapes and walk caps", () => {
  const outsideHooks = json({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo out" }] }] },
  });

  test.each([
    {
      name: "a path that climbs out of the plugin",
      declared: "../outside.json",
      expected: "../outside.json (outside the plugin)",
    },
    {
      name: "a declared file that is missing",
      declared: "missing.json",
      expected: "missing.json (not found)",
    },
    {
      name: "a declared file that is a link",
      declared: "linked.json",
      expected: "linked.json (a link)",
    },
    {
      name: "a declared path through a linked folder",
      declared: "linkdir/hooks.json",
      expected: "linkdir/hooks.json (a link)",
    },
  ])("refuses $name and never reads past the plugin", async ({ declared, expected }) => {
    const root = plugin({ ".claude-plugin/plugin.json": json({ name: "p", hooks: declared }) });
    const base = path.dirname(root);
    writeFileSync(path.join(base, "outside.json"), outsideHooks);
    symlinkSync(path.join(base, "outside.json"), path.join(root, "linked.json"));
    mkdirSync(path.join(base, "outdir"));
    writeFileSync(path.join(base, "outdir", "hooks.json"), outsideHooks);
    symlinkSync(path.join(base, "outdir"), path.join(root, "linkdir"));
    const c = await readContents(root);
    expect(c.hooks).toEqual([]);
    expect(c.unshown).toEqual([expected]);
  });

  test("refuses an absolute path to a file outside the plugin", async () => {
    const root = plugin({});
    const outside = path.join(path.dirname(root), "outside.json");
    writeFileSync(outside, outsideHooks);
    mkdirSync(path.join(root, ".claude-plugin"));
    writeFileSync(
      path.join(root, ".claude-plugin", "plugin.json"),
      json({ name: "p", hooks: outside }),
    );
    const c = await readContents(root);
    expect(c.hooks).toEqual([]);
    expect(c.unshown).toEqual([`${outside} (outside the plugin)`]);
  });

  test.each([
    { name: "a hooks file that is a JSON array", content: "[1, 2]" },
    { name: "a hook event whose value isn't a list", content: json({ hooks: { Stop: "echo" } }) },
    {
      name: "a hook group without a list of hooks",
      content: json({ hooks: { Stop: [{ matcher: "x" }] } }),
    },
  ])("lists $name as not in the expected shape", async ({ content }) => {
    const c = await readContents(plugin({ "hooks/hooks.json": content }));
    expect(c.hooks).toEqual([]);
    expect(c.unshown).toEqual(["hooks/hooks.json (not in the expected shape)"]);
  });

  test("lists an MCP server that isn't an object", async () => {
    const c = await readContents(plugin({ ".mcp.json": json({ mcpServers: { s: 5 } }) }));
    expect(c.mcp).toEqual([]);
    expect(c.unshown).toEqual([".mcp.json (not in the expected shape)"]);
  });

  test("lists a link in bin/ and still shows the executables", async () => {
    const root = plugin({ "bin/tool": "#!/bin/sh\n" });
    const outside = path.join(path.dirname(root), "outside-tool");
    writeFileSync(outside, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(outside, path.join(root, "bin", "link"));
    const c = await readContents(root);
    expect(c.codeParts).toEqual([{ kind: "bin", items: ["bin/tool"] }]);
    expect(c.unshown).toEqual(["bin/link (a link)"]);
  });

  test("lists the executables of bin/ even when the walk of the plugin stopped", async () => {
    const files: Record<string, string> = { "bin/tool": "#!/bin/sh\n" };
    for (let i = 0; i < 2001; i++) files[`a/f${i}.txt`] = "x";
    const c = await readContents(plugin(files));
    expect(c.codeParts).toEqual([{ kind: "bin", items: ["bin/tool"] }]);
    expect(c.unshown).toEqual(["a walk stopped at 2,000 files"]);
  });

  test("lists a walk that stopped at 2,000 folders", async () => {
    const root = plugin({});
    for (let i = 0; i < 2001; i++) mkdirSync(path.join(root, "d", String(i)), { recursive: true });
    expect((await readContents(root)).unshown).toEqual(["a walk stopped at 2,000 folders"]);
  });

  test.skipIf(process.getuid?.() === 0)("lists a folder that can't be read", async () => {
    const root = plugin({ "locked/a.txt": "x" });
    const locked = path.join(root, "locked");
    chmodSync(locked, 0o000);
    try {
      expect((await readContents(root)).unshown).toEqual(["locked (can't be read)"]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("readContents: files, manifest and provides", () => {
  test("files lists only referenced regular files inside the root", async () => {
    const outside = plugin({ "secret.sh": "echo secret\n" });
    const root = plugin({
      "hooks/hooks.json": json({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "bash ${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" },
                { type: "command", command: "bash ${CLAUDE_PLUGIN_ROOT}/scripts/linked.sh" },
                { type: "command", command: "bash ${CLAUDE_PLUGIN_ROOT}/scripts/missing.sh" },
                { type: "command", command: "bash ${CLAUDE_PLUGIN_ROOT}/../escape.sh" },
                { type: "command", command: "bash $CLAUDE_PLUGIN_ROOT/scripts/bare.sh" },
              ],
            },
          ],
        },
      }),
      ".mcp.json": json({
        mcpServers: { s: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/index.js"] } },
      }),
      "scripts/run.sh": "echo run\n",
      "scripts/bare.sh": "echo bare\n",
      "scripts/other.sh": "echo unreferenced\n",
      "server/index.js": "console.log(1)\n",
    });
    // The climbing reference resolves to a real file one level above the plugin: it must still be excluded.
    writeFileSync(path.join(path.dirname(root), "escape.sh"), "echo out\n");
    symlinkSync(path.join(outside, "secret.sh"), path.join(root, "scripts", "linked.sh"));
    const c = await readContents(root);
    expect(c.files).toEqual(["scripts/bare.sh", "scripts/run.sh", "server/index.js"]);
  });

  test("reads the manifest fields", async () => {
    const root = plugin({
      ".claude-plugin/plugin.json": json({
        name: "lint-helper",
        version: "1.3.0",
        description: "Lints things",
        author: { name: "Ada" },
        homepage: "https://example.test",
      }),
    });
    expect((await readContents(root)).manifest).toEqual({
      name: "lint-helper",
      version: "1.3.0",
      description: "Lints things",
      author: "Ada",
      homepage: "https://example.test",
      repository: null,
    });
  });

  test("names skills, commands, agents and output styles by their files", async () => {
    const root = plugin({
      "skills/review/SKILL.md": "---\nname: review\n---\n",
      "commands/deploy.md": "# deploy\n",
      "agents/triage.md": "# triage\n",
      "output-styles/terse.md": "# terse\n",
    });
    const c = await readContents(root);
    expect(c.provides).toEqual({
      skills: ["review"],
      commands: ["deploy"],
      agents: ["triage"],
      outputStyles: ["terse"],
    });
  });
});

describe("diffContents", () => {
  test("reports a hook added and an MCP server removed, and flags them as code", async () => {
    const before = await readContents(
      plugin({ ".mcp.json": json({ mcpServers: { old: { command: "node", args: ["a.js"] } } }) }),
    );
    const after = await readContents(
      plugin({
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
        }),
      }),
    );
    const d = diffContents(before, after);
    expect(d.hooks.added.map((h) => h.command)).toEqual(["echo done"]);
    expect(d.mcp.removed.map((s) => s.name)).toEqual(["old"]);
    expect(d.runsCode).toBe(true);
  });

  test("reports a changed dependency and a new need", async () => {
    const before = await readContents(
      plugin({ ".claude-plugin/plugin.json": json({ dependencies: ["lint@1"] }) }),
    );
    const after = await readContents(
      plugin({
        ".claude-plugin/plugin.json": json({ dependencies: ["lint@2"] }),
        "hooks/hooks.json": json({
          hooks: { Stop: [{ hooks: [{ type: "command", command: "npx -y x" }] }] },
        }),
      }),
    );
    const d = diffContents(before, after);
    expect(d.dependencies).toEqual({ added: ["lint@2"], removed: ["lint@1"] });
    expect(d.needs.added).toEqual(["npx"]);
  });

  test("a dependencies-only change is flagged as running code", async () => {
    const before = await readContents(
      plugin({ ".claude-plugin/plugin.json": json({ dependencies: ["lint@1"] }) }),
    );
    const after = await readContents(
      plugin({ ".claude-plugin/plugin.json": json({ dependencies: ["lint@2"] }) }),
    );
    expect(diffContents(before, after).runsCode).toBe(true);
  });

  test("a changed description is neither code nor a diff", async () => {
    const before = await readContents(
      plugin({ ".claude-plugin/plugin.json": json({ description: "a" }) }),
    );
    const after = await readContents(
      plugin({ ".claude-plugin/plugin.json": json({ description: "b" }) }),
    );
    const d = diffContents(before, after);
    expect(d.runsCode).toBe(false);
    expect(d.hooks).toEqual({ added: [], removed: [] });
    expect(d.mcp).toEqual({ added: [], removed: [] });
  });
});
