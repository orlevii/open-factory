import path from "node:path";
import { makeFixtureRepo } from "./fixture-repo.ts";

/** A Stop hook that runs `command`. */
export const stopHook = (command: string) =>
  JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } });

const ROOT = "$" + "{CLAUDE_PLUGIN_ROOT}";

/**
 * The `acme` marketplace as `acme/mk` under `<tmp>/gh` (two commits) and the external plugin repo `ext/plug`:
 * - `rel`, a relative-path plugin: 1.0.0 with one hook at the first commit, 1.1.0 with a second hook at the second;
 * - `ext`, an external github source held by a `sha`, with one hook;
 * - `loose`, an external source with no `sha` (Latest only), and `bad`, an `npm` source (refused).
 */
export async function makeAcmeMarketplace(tmp: string) {
  const ext = await makeFixtureRepo(path.join(tmp, "gh", "ext", "plug.git"), {
    commits: [
      {
        ".claude-plugin/plugin.json": JSON.stringify({ name: "ext", version: "3.0.0" }),
        "hooks/hooks.json": stopHook("uvx ext-tool"),
      },
    ],
  });
  const plugins = [
    { name: "rel", description: "relative plugin", source: "./plugins/rel", version: "1.0.0" },
    { name: "ext", source: { source: "github", repo: "ext/plug", sha: ext.shas[0] } },
    { name: "loose", source: { source: "github", repo: "ext/plug" } },
    { name: "bad", source: { source: "npm", package: "x" } },
  ];
  const catalog = (list: unknown[]) => ({
    ".claude-plugin/marketplace.json": JSON.stringify({ name: "acme", plugins: list }),
  });
  const repo = await makeFixtureRepo(path.join(tmp, "gh", "acme", "mk.git"), {
    commits: [
      {
        ...catalog(plugins),
        "plugins/rel/.claude-plugin/plugin.json": JSON.stringify({ name: "rel", version: "1.0.0" }),
        "plugins/rel/hooks/hooks.json": stopHook(`node ${ROOT}/a.js`),
        "plugins/rel/a.js": "console.log('a')\n",
      },
      {
        ...catalog(plugins.map((p) => (p.name === "rel" ? { ...p, version: "1.1.0" } : p))),
        "plugins/rel/.claude-plugin/plugin.json": JSON.stringify({ name: "rel", version: "1.1.0" }),
        "plugins/rel/hooks/hooks.json": JSON.stringify({
          hooks: {
            Stop: [
              {
                hooks: [
                  { type: "command", command: `node ${ROOT}/a.js` },
                  { type: "command", command: "python3 b.py" },
                ],
              },
            ],
          },
        }),
        "plugins/rel/a.js": "console.log('a')\n",
      },
    ],
  });
  return { repoShas: repo.shas, extSha: ext.shas[0] as string };
}
