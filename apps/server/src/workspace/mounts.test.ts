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

test.each([
  ["/", "root"],
  [os.homedir(), "home"],
  ["<home>", "FACTORY_HOME"],
  ["<home>/state", "state"],
  ["<parent>", "ancestor of FACTORY_HOME"],
  ["/var/run/docker.sock", "docker socket"],
  ["<home>/agents/other", "another agent's workdir"],
  ["<home>/state/agents/other/plugins-config/plugins", "another agent's plugins"],
])("refuses %s (%s)", async (raw) => {
  const src = raw.replace("<home>", home).replace("<parent>", path.dirname(home));
  await expect(checkMounts([{ source: src, target: src, readOnly: true }], ctx)).rejects.toThrow(
    MountRefusedError,
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
  await expect(checkMounts(buildMounts(inputs), ctx)).resolves.toBeUndefined();
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
