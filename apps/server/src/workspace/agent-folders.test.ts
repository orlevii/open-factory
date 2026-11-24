import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FACTORY_ENV_NAMES, RESERVED_SETTINGS_KEYS } from "@open-factory/shared";
import { beforeEach, describe, expect, test } from "vitest";
import {
  checkAgentFrontmatter,
  checkProjectSettings,
  checkSkillPlugins,
  scrubAgentFolders,
} from "./agent-folders.ts";

let wd: string;
beforeEach(() => {
  wd = realpathSync(mkdtempSync(path.join(tmpdir(), "of-folders-")));
  mkdirSync(path.join(wd, ".claude"), { recursive: true });
});

const put = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(wd, rel)), { recursive: true });
  writeFileSync(path.join(wd, rel), text);
};
const outside = () => realpathSync(mkdtempSync(path.join(tmpdir(), "of-outside-")));

/** `{ a: { b: {} } }` for "a.b": the settings object that sets exactly that key. */
const settingWith = (dotted: string): Record<string, unknown> => {
  const parts = dotted.split(".");
  const leaf = parts.pop() as string;
  const root: Record<string, unknown> = {};
  let cur = root;
  for (const p of parts) {
    const next: Record<string, unknown> = {};
    cur[p] = next;
    cur = next;
  }
  cur[leaf] = {};
  return root;
};

describe("checkProjectSettings", () => {
  test("settings.local.json with hooks fails naming the file and the key", async () => {
    put(".claude/settings.local.json", JSON.stringify({ hooks: {} }));
    await expect(checkProjectSettings(wd)).rejects.toThrow(
      `${path.join(wd, ".claude/settings.local.json")} sets hooks, which agents can't set; remove it.`,
    );
  });

  test.each(
    ["settings.json", "settings.local.json"].flatMap((file) =>
      RESERVED_SETTINGS_KEYS.map((key) => [file, key] as const),
    ),
  )("%s fails on reserved key %s", async (file, key) => {
    put(`.claude/${file}`, JSON.stringify(settingWith(key)));
    await expect(checkProjectSettings(wd)).rejects.toThrow(
      `${path.join(wd, ".claude", file)} sets ${key}, which agents can't set; remove it.`,
    );
  });

  test.each([
    ["OPEN_FACTORY_URL", "OPEN_FACTORY_URL"],
    [FACTORY_ENV_NAMES[0] as string, FACTORY_ENV_NAMES[0] as string],
  ])("env.%s fails", async (name) => {
    put(".claude/settings.json", JSON.stringify({ env: { [name]: "x" } }));
    await expect(checkProjectSettings(wd)).rejects.toThrow(`sets env.${name}, which`);
  });

  test("an ordinary env entry and other keys pass; so do missing and empty files", async () => {
    await checkProjectSettings(wd);
    put(".claude/settings.json", JSON.stringify({ env: { FOO: "1" }, model: "opus" }));
    put(".claude/settings.local.json", "  \n");
    await checkProjectSettings(wd);
  });

  test("a link at either path fails, whatever it points at", async () => {
    const target = path.join(outside(), "s.json");
    writeFileSync(target, "{}");
    symlinkSync(target, path.join(wd, ".claude/settings.json"));
    await expect(checkProjectSettings(wd)).rejects.toThrow(/settings\.json is a link/);
  });

  test("a file that doesn't parse as a JSON object fails closed", async () => {
    put(".claude/settings.json", "{ nope");
    await expect(checkProjectSettings(wd)).rejects.toThrow(/isn't valid JSON/);
    put(".claude/settings.json", "[]");
    await expect(checkProjectSettings(wd)).rejects.toThrow(/isn't a JSON object/);
  });
});

describe("checkAgentFrontmatter", () => {
  const hooksFm = "---\nname: x\nhooks:\n  PreToolUse: []\n---\nbody\n";

  test("an agent-written skill that declares hooks fails", async () => {
    put(".claude/skills/x/SKILL.md", hooksFm);
    await expect(checkAgentFrontmatter(wd, new Set())).rejects.toThrow(
      "skills/x declares hooks, which agents can't set; remove them.",
    );
  });

  test("a factory link to a Library skill with hooks passes; an agent link to the same folder fails", async () => {
    const lib = outside();
    writeFileSync(path.join(lib, "SKILL.md"), hooksFm);
    mkdirSync(path.join(wd, ".claude/skills"), { recursive: true });
    symlinkSync(lib, path.join(wd, ".claude/skills/x"));
    await checkAgentFrontmatter(wd, new Set(["x"]));
    await expect(checkAgentFrontmatter(wd, new Set())).rejects.toThrow("skills/x declares hooks");
  });

  test("an agent-written skill without hooks passes", async () => {
    put(".claude/skills/x/SKILL.md", "---\nname: x\n---\nbody\n");
    await checkAgentFrontmatter(wd, new Set());
  });

  test.each(["hooks", "mcpServers"])("a subagent that declares %s fails", async (key) => {
    put(".claude/agents/a.md", `---\nname: a\n${key}: {}\n---\nbody\n`);
    await expect(checkAgentFrontmatter(wd, new Set())).rejects.toThrow(
      `agents/a.md declares ${key}, which agents can't set; remove them.`,
    );
  });

  test("a subagent in a subfolder is checked too, and a plain one passes", async () => {
    put(".claude/agents/plain.md", "---\nname: p\n---\n");
    await checkAgentFrontmatter(wd, new Set());
    put(".claude/agents/team/b.md", "---\nname: b\nhooks: {}\n---\n");
    await expect(checkAgentFrontmatter(wd, new Set())).rejects.toThrow(
      "agents/team/b.md declares hooks",
    );
  });

  test("a command with hooks in its frontmatter fails; its body text doesn't matter", async () => {
    put(".claude/commands/c.md", "---\ndescription: c\n---\nmention hooks: here\n");
    await checkAgentFrontmatter(wd, new Set());
    put(".claude/commands/c.md", "---\nhooks: {}\n---\n");
    await expect(checkAgentFrontmatter(wd, new Set())).rejects.toThrow(
      "commands/c.md declares hooks, which agents can't set; remove them.",
    );
  });

  test("a link to a file outside the workdir is read as Claude would read it", async () => {
    const f = path.join(outside(), "a.md");
    writeFileSync(f, "---\nmcpServers: {}\n---\n");
    mkdirSync(path.join(wd, ".claude/agents"), { recursive: true });
    symlinkSync(f, path.join(wd, ".claude/agents/a.md"));
    await expect(checkAgentFrontmatter(wd, new Set())).rejects.toThrow(
      "agents/a.md declares mcpServers",
    );
  });

  test("a file too large to check fails closed", async () => {
    put(".claude/agents/big.md", `---\nname: a\n---\n${"x".repeat(300 * 1024)}`);
    await expect(checkAgentFrontmatter(wd, new Set())).rejects.toThrow(/larger than 256 KB/);
  });
});

describe("checkSkillPlugins", () => {
  test("a link the agent made to a folder holding .claude-plugin/ fails", async () => {
    const plugin = outside();
    mkdirSync(path.join(plugin, ".claude-plugin"));
    mkdirSync(path.join(wd, ".claude/skills"), { recursive: true });
    symlinkSync(plugin, path.join(wd, ".claude/skills/x"));
    await expect(checkSkillPlugins(wd)).rejects.toThrow(
      "skills/x is a plugin, so it can't load as a skill; move it away.",
    );
  });

  test("a folder the agent wrote with .claude-plugin/ fails, and plain skills and files pass", async () => {
    put(".claude/skills/ok/SKILL.md", "x");
    put(".claude/skills/README.md", "x");
    await checkSkillPlugins(wd);
    put(".claude/skills/p/.claude-plugin/plugin.json", "{}");
    await expect(checkSkillPlugins(wd)).rejects.toThrow("skills/p is a plugin");
  });

  test("no skills folder is fine", async () => {
    await checkSkillPlugins(wd);
  });
});

describe("scrubAgentFolders", () => {
  test("empties skills, agents and commands under .claude-config and leaves the rest", async () => {
    put(".claude-config/skills/a/SKILL.md", "x");
    put(".claude-config/agents/a.md", "x");
    put(".claude-config/commands/sub/c.md", "x");
    put(".claude-config/settings.json", "{}");
    await scrubAgentFolders(wd);
    for (const d of ["skills", "agents", "commands"])
      expect(readdirSync(path.join(wd, ".claude-config", d))).toEqual([]);
    expect(existsSync(path.join(wd, ".claude-config/settings.json"))).toBe(true);
  });

  test("a link inside is removed as a link and its target is untouched", async () => {
    const target = outside();
    writeFileSync(path.join(target, "keep"), "x");
    mkdirSync(path.join(wd, ".claude-config/skills"), { recursive: true });
    symlinkSync(target, path.join(wd, ".claude-config/skills/evil"));
    await scrubAgentFolders(wd);
    expect(existsSync(path.join(wd, ".claude-config/skills/evil"))).toBe(false);
    expect(existsSync(path.join(target, "keep"))).toBe(true);
  });

  test("a link in the folder's own place is removed as a link, never followed", async () => {
    const target = outside();
    writeFileSync(path.join(target, "keep"), "x");
    mkdirSync(path.join(wd, ".claude-config"), { recursive: true });
    symlinkSync(target, path.join(wd, ".claude-config/agents"));
    await scrubAgentFolders(wd);
    expect(
      lstatSync(path.join(wd, ".claude-config"), { throwIfNoEntry: false })?.isDirectory(),
    ).toBe(true);
    expect(existsSync(path.join(wd, ".claude-config/agents"))).toBe(false);
    expect(existsSync(path.join(target, "keep"))).toBe(true);
  });

  test("a link on the way (.claude-config itself) fails rather than write through it", async () => {
    const target = outside();
    symlinkSync(target, path.join(wd, ".claude-config"));
    await expect(scrubAgentFolders(wd)).rejects.toThrow(/symlink/);
  });

  test("nothing there is fine", async () => {
    await scrubAgentFolders(wd);
  });
});
