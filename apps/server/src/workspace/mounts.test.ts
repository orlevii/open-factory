import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import {
  buildMounts,
  checkMounts,
  declaredMarketplaceDirs,
  dockerSocketPaths,
  type MountCheckContext,
  MountRefusedError,
} from "./mounts.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), p)));

test("path parity; plugins dir and CLI bundle read-only; bundle at the fixed target", () => {
  expect(
    buildMounts({
      workdir: "/w",
      grantedPaths: ["/code/app"],
      hostSkillPaths: ["/real/skills/grilling"],
      declaredMarketplaceDirs: ["/mk"],
      pluginsDir: "/fh/state/agents/a/plugins-config/plugins",
      cliBundle: "/repo/apps/cli/dist/open-factory.js",
    }),
  ).toEqual([
    { source: "/w", target: "/w", readOnly: false },
    { source: "/code/app", target: "/code/app", readOnly: false },
    { source: "/real/skills/grilling", target: "/real/skills/grilling", readOnly: true },
    { source: "/mk", target: "/mk", readOnly: true },
    {
      source: "/fh/state/agents/a/plugins-config/plugins",
      target: "/fh/state/agents/a/plugins-config/plugins",
      readOnly: true,
    },
    {
      source: "/repo/apps/cli/dist/open-factory.js",
      target: "/opt/factory/bin/open-factory",
      readOnly: true,
    },
  ]);
});

test("declaredMarketplaceDirs keeps only directory sources", () => {
  expect(
    declaredMarketplaceDirs({
      extraKnownMarketplaces: {
        a: { source: { source: "directory", path: "/mk" } },
        b: { source: { source: "github", repo: "o/r" } },
        c: null,
      },
    }),
  ).toEqual(["/mk"]);
  expect(declaredMarketplaceDirs({})).toEqual([]);
});

test("dockerSocketPaths: the defaults plus a DOCKER_HOST unix path", () => {
  expect(dockerSocketPaths({}, "/h")).toEqual([
    "/var/run/docker.sock",
    "/h/.docker/run/docker.sock",
  ]);
  expect(dockerSocketPaths({ DOCKER_HOST: "unix:///tmp/d.sock" }, "/h")).toContain("/tmp/d.sock");
  expect(dockerSocketPaths({ DOCKER_HOST: "tcp://1.2.3.4:2375" }, "/h")).toHaveLength(2);
});

let home: string;
let inputs: Parameters<typeof buildMounts>[0];
let ctx: MountCheckContext;

beforeEach(() => {
  home = tmp("of-mounts-");
  const workdir = path.join(home, "agents/lead");
  const pluginsDir = path.join(home, "state/agents/lead/plugins-config/plugins");
  for (const d of [
    workdir,
    pluginsDir,
    path.join(home, "agents/other"),
    path.join(home, "state/agents/other/plugins-config/plugins"),
  ])
    mkdirSync(d, { recursive: true });
  const repo = tmp("repo-");
  const skill = tmp("skill-");
  const mk = tmp("mk-");
  const cliBundle = path.join(tmp("cli-"), "open-factory.js");
  writeFileSync(cliBundle, "//");
  inputs = {
    workdir,
    grantedPaths: [repo],
    hostSkillPaths: [skill],
    declaredMarketplaceDirs: [mk],
    pluginsDir,
    cliBundle,
  };
  ctx = {
    ...inputs,
    factoryHome: home,
    home: os.homedir(),
    dockerSockets: dockerSocketPaths({}, os.homedir()),
  };
});

// Each source is also declared (rw and ro), so only its specific forbidden rule can refuse it.
test.each([
  ["/", "root", "it is the filesystem root"],
  [os.homedir(), "home", "it is the host home directory"],
  ["<home>", "FACTORY_HOME", "it is FACTORY_HOME"],
  ["<home>/state", "state", "it is the factory state directory"],
  ["<parent>", "ancestor of FACTORY_HOME", "it contains FACTORY_HOME"],
  ["<sock>", "docker socket", "it is a Docker socket"],
  [
    "<home>/agents/other",
    "another agent's workdir",
    "it is inside FACTORY_HOME and isn't this agent's workdir or plugins dir",
  ],
  [
    "<home>/state/agents/other/plugins-config/plugins",
    "another agent's plugins",
    "it is inside FACTORY_HOME and isn't this agent's workdir or plugins dir",
  ],
])("refuses %s (%s)", async (raw, _kind, reason) => {
  const sock = path.join(tmp("sock-"), "docker.sock");
  writeFileSync(sock, "");
  const src = raw
    .replace("<home>", home)
    .replace("<parent>", path.dirname(home))
    .replace("<sock>", sock);
  const declared = {
    ...ctx,
    grantedPaths: [src],
    hostSkillPaths: [src],
    dockerSockets: [...ctx.dockerSockets, sock],
  };
  for (const readOnly of [true, false])
    await expect(checkMounts([{ source: src, target: src, readOnly }], declared)).rejects.toThrow(
      `Mount ${src} isn't allowed: ${reason}.`,
    );
});

test("refuses a home ancestor and a Docker socket even when they are declared inputs", async () => {
  const sock = path.join(tmp("sock-"), "docker.sock");
  writeFileSync(sock, "");
  const withSock = { ...ctx, hostSkillPaths: [sock], dockerSockets: [sock] };
  await expect(
    checkMounts([{ source: sock, target: sock, readOnly: true }], withSock),
  ).rejects.toThrow(`Mount ${sock} isn't allowed: it is a Docker socket.`);
  await expect(
    checkMounts([{ source: home, target: home, readOnly: false }], {
      ...ctx,
      grantedPaths: [home],
    }),
  ).rejects.toThrow(`Mount ${home} isn't allowed: it is FACTORY_HOME.`);
});

test("allows exactly the declared kinds with the right read-only flags", async () => {
  await expect(checkMounts(buildMounts(inputs), ctx)).resolves.toEqual(buildMounts(inputs));
  expect(
    buildMounts(inputs).find((m) => m.target === "/opt/factory/bin/open-factory"),
  ).toMatchObject({ readOnly: true });
  expect(buildMounts(inputs).find((m) => m.source === inputs.workdir)).toMatchObject({
    readOnly: false,
  });
});

test("refuses a wrong read-only flag, a wrong target and an undeclared path", async () => {
  const [repo] = inputs.grantedPaths as [string];
  await expect(
    checkMounts([{ source: inputs.workdir, target: inputs.workdir, readOnly: true }], ctx),
  ).rejects.toThrow("it must be writable");
  await expect(
    checkMounts([{ source: inputs.pluginsDir, target: inputs.pluginsDir, readOnly: false }], ctx),
  ).rejects.toThrow("it must be read-only");
  await expect(
    checkMounts([{ source: repo, target: "/etc", readOnly: false }], ctx),
  ).rejects.toThrow("its target /etc isn't the allowed one");
  await expect(
    checkMounts([{ source: inputs.cliBundle, target: inputs.cliBundle, readOnly: true }], ctx),
  ).rejects.toThrow(MountRefusedError);
  const stray = tmp("stray-");
  await expect(
    checkMounts([{ source: stray, target: stray, readOnly: true }], ctx),
  ).rejects.toThrow("it isn't one of the agent's allowed mounts");
  await expect(
    checkMounts(
      [{ source: "/nonexistent/of-x", target: "/nonexistent/of-x", readOnly: true }],
      ctx,
    ),
  ).rejects.toThrow(MountRefusedError);
});

test("a granted project inside FACTORY_HOME is refused even when declared", async () => {
  const other = path.join(home, "agents/other");
  await expect(
    checkMounts([{ source: other, target: other, readOnly: false }], {
      ...ctx,
      grantedPaths: [other],
    }),
  ).rejects.toThrow(
    `Mount ${other} isn't allowed: it is inside FACTORY_HOME and isn't this agent's workdir or plugins dir.`,
  );
});

test("checkMounts resolves symlinks before checking", async () => {
  const link = path.join(tmp("link-"), "innocent");
  symlinkSync(os.homedir(), link);
  await expect(
    checkMounts([{ source: link, target: link, readOnly: false }], {
      ...ctx,
      grantedPaths: [link],
    }),
  ).rejects.toThrow(`Mount ${link} isn't allowed: it is the host home directory.`);
});

test("returns the realpath, so Docker binds the checked path and not a swappable link", async () => {
  const [repo] = inputs.grantedPaths as [string];
  const link = path.join(tmp("link-"), "app");
  symlinkSync(repo, link);
  await expect(
    checkMounts([{ source: link, target: link, readOnly: false }], {
      ...ctx,
      grantedPaths: [link],
    }),
  ).resolves.toEqual([{ source: repo, target: repo, readOnly: false }]);
  await expect(
    checkMounts(
      [{ source: inputs.cliBundle, target: "/opt/factory/bin/open-factory", readOnly: true }],
      ctx,
    ),
  ).resolves.toEqual([
    { source: inputs.cliBundle, target: "/opt/factory/bin/open-factory", readOnly: true },
  ]);
});

test("a not-yet-created socket under a linked prefix is still forbidden", async () => {
  const real = tmp("dh-");
  mkdirSync(path.join(real, "run"));
  const linkDir = path.join(tmp("dhl-"), "alias");
  symlinkSync(real, linkDir);
  const runDir = path.join(real, "run");
  await expect(
    checkMounts([{ source: runDir, target: runDir, readOnly: false }], {
      ...ctx,
      grantedPaths: [runDir],
      dockerSockets: [path.join(linkDir, "run/d.sock")],
    }),
  ).rejects.toThrow(`Mount ${runDir} isn't allowed: it contains a Docker socket.`);
});

test("refuses relative sources and targets", async () => {
  const [repo] = inputs.grantedPaths as [string];
  await expect(
    checkMounts([{ source: "mk", target: "mk", readOnly: true }], {
      ...ctx,
      declaredMarketplaceDirs: ["mk"],
    }),
  ).rejects.toThrow("Mount mk isn't allowed: its source and target must be absolute paths.");
  await expect(
    checkMounts([{ source: repo, target: "app", readOnly: false }], ctx),
  ).rejects.toThrow("its source and target must be absolute paths");
});

test("forbids the account's home even when HOME points elsewhere", async () => {
  const real = os.userInfo().homedir;
  await expect(
    checkMounts([{ source: real, target: real, readOnly: false }], {
      ...ctx,
      home: tmp("fake-home-"),
      grantedPaths: [real],
    }),
  ).rejects.toThrow(`Mount ${real} isn't allowed: it is the host home directory.`);
});
