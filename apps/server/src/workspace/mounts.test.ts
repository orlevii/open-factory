import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
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
      skillPaths: ["/real/skills/grilling"],
      templateSkillPaths: ["/fh/templates/t/skills/x"],
      declaredMarketplaceDirs: ["/mk"],
      pluginsDir: "/fh/state/agents/a/plugins-config/plugins",
      cliBundle: "/repo/apps/cli/dist/open-factory.js",
    }),
  ).toEqual([
    { source: "/w", target: "/w", readOnly: false },
    { source: "/code/app", target: "/code/app", readOnly: false },
    { source: "/real/skills/grilling", target: "/real/skills/grilling", readOnly: true },
    { source: "/fh/templates/t/skills/x", target: "/fh/templates/t/skills/x", readOnly: true },
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
    skillPaths: [skill],
    templateSkillPaths: [],
    declaredMarketplaceDirs: [mk],
    pluginsDir,
    cliBundle,
  };
  ctx = {
    ...inputs,
    templateDir: path.join(home, "templates/t"),
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
    "it is inside FACTORY_HOME and isn't this agent's workdir, a registered skill or the plugin store",
  ],
  [
    "<home>/state/agents/other/plugins-config/plugins",
    "another agent's plugins",
    "it is inside FACTORY_HOME and isn't this agent's workdir, a registered skill or the plugin store",
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
    skillPaths: [src],
    dockerSockets: [...ctx.dockerSockets, sock],
  };
  for (const readOnly of [true, false])
    await expect(checkMounts([{ source: src, target: src, readOnly }], declared)).rejects.toThrow(
      `Mount ${src} isn't allowed: ${reason}.`,
    );
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

// Spec §6.4. The default layout: FACTORY_HOME is `<HOME>/open-factory`, so the host home is its parent.
describe("template skills", () => {
  let hostHome: string;
  let tplDir: string;
  let skill: string;
  let tctx: MountCheckContext;
  const mountOf = (source: string, readOnly = true) => ({ source, target: source, readOnly });
  const declare = (...p: string[]) => {
    tctx = { ...tctx, templateSkillPaths: p };
  };

  beforeEach(() => {
    hostHome = tmp("host-home-");
    const factory = path.join(hostHome, "open-factory");
    tplDir = path.join(factory, "templates/t");
    skill = path.join(tplDir, "skills/x");
    const workdir = path.join(factory, "agents/lead");
    const pluginsDir = path.join(factory, "state/agents/lead/plugins-config/plugins");
    for (const d of [skill, workdir, pluginsDir, path.join(factory, "state/agents/bob")])
      mkdirSync(d, { recursive: true });
    mkdirSync(path.join(hostHome, ".ssh"));
    const cliBundle = path.join(tmp("cli-"), "open-factory.js");
    writeFileSync(cliBundle, "//");
    tctx = {
      workdir,
      grantedPaths: [],
      skillPaths: [],
      templateSkillPaths: [skill],
      templateDir: tplDir,
      declaredMarketplaceDirs: [],
      pluginsDir,
      cliBundle,
      factoryHome: factory,
      home: hostHome,
      dockerSockets: [],
    };
  });

  test("a real template skill folder mounts read-only at its real path", async () => {
    await expect(checkMounts([mountOf(skill)], tctx)).resolves.toEqual([mountOf(skill)]);
    await expect(checkMounts([mountOf(skill, false)], tctx)).rejects.toThrow(MountRefusedError);
  });

  test("a symlinked template folder mounts at its real path", async () => {
    const alias = path.join(tctx.factoryHome, "templates/alias");
    symlinkSync(tplDir, alias);
    declare(skill);
    await expect(checkMounts([mountOf(skill)], { ...tctx, templateDir: alias })).resolves.toEqual([
      mountOf(skill),
    ]);
  });

  test("the exemption doesn't make a writable grant under FACTORY_HOME legal", async () => {
    await expect(
      checkMounts([mountOf(skill, false)], { ...tctx, grantedPaths: [skill] }),
    ).rejects.toThrow("it is inside FACTORY_HOME");
  });

  // The reasons are the general rules': the exemption never applied. Were its `lstat` or realpath checks gone, a link
  // into the home would mount and a link into state would hit the exemption's own refusal instead.
  const OUTSIDE = "it isn't one of the agent's allowed mounts";
  const IN_FACTORY =
    "it is inside FACTORY_HOME and isn't this agent's workdir, a registered skill or the plugin store";
  test.each([
    ["a skill entry symlinked to ~/.ssh", "entry", () => path.join(hostHome, ".ssh"), OUTSIDE],
    [
      "a skill entry symlinked to state/agents/bob",
      "entry",
      () => path.join(tctx.factoryHome, "state/agents/bob"),
      IN_FACTORY,
    ],
    ["skills/ symlinked to ~/.ssh", "dir", () => path.join(hostHome, ".ssh"), OUTSIDE],
    [
      "skills/ symlinked to state/agents/bob",
      "dir",
      () => path.join(tctx.factoryHome, "state/agents/bob"),
      IN_FACTORY,
    ],
  ])("refuses %s at start", async (_n, what, target, reason) => {
    const to = target();
    mkdirSync(path.join(to, "x"), { recursive: true });
    let declared: string;
    if (what === "entry") {
      rmSync(skill, { recursive: true });
      symlinkSync(path.join(to, "x"), skill);
      declared = path.join(to, "x");
    } else {
      rmSync(path.join(tplDir, "skills"), { recursive: true });
      symlinkSync(to, path.join(tplDir, "skills"));
      declared = path.join(to, "x");
    }
    // Declared both as its real path and as the link's spelling: neither is allowed.
    for (const d of [declared, skill]) {
      declare(d);
      await expect(checkMounts([mountOf(d)], tctx)).rejects.toThrow(reason);
    }
  });

  test("a skill path that isn't exactly <templates>/<template>/skills/<name> is refused", async () => {
    const other = path.join(tctx.factoryHome, "templates/u/skills/x");
    mkdirSync(other, { recursive: true });
    const nested = path.join(skill, "deep");
    mkdirSync(nested);
    for (const p of [other, nested, path.join(tplDir, "skills"), tplDir]) {
      declare(p);
      // Refused by the general FACTORY_HOME rule: the exemption's exact-location check left it out.
      await expect(checkMounts([mountOf(p)], tctx)).rejects.toThrow(IN_FACTORY);
    }
  });

  test("a template whose real folder is a workdir or state is refused", async () => {
    const bob = path.join(tctx.factoryHome, "state/agents/bob");
    mkdirSync(path.join(bob, "skills/x"), { recursive: true });
    const wd = path.join(tctx.factoryHome, "agents/other");
    mkdirSync(path.join(wd, "skills/x"), { recursive: true });
    for (const real of [bob, wd]) {
      const alias = path.join(tctx.factoryHome, `templates/via-${path.basename(real)}`);
      symlinkSync(real, alias);
      const p = path.join(real, "skills/x");
      declare(p);
      await expect(checkMounts([mountOf(p)], { ...tctx, templateDir: alias })).rejects.toThrow(
        "it is inside the factory state or an agent's workdir",
      );
    }
  });

  test("the host home, state, workdirs and their ancestors stay refused", async () => {
    const stateDir = path.join(tctx.factoryHome, "state");
    for (const [p, reason] of [
      [hostHome, "it is the host home directory"],
      [tctx.factoryHome, "it is FACTORY_HOME"],
      [stateDir, "it is the factory state directory"],
      // Allowed only as the writable workdir: declaring it a template skill never makes it a read-only mount.
      [tctx.workdir, "it must be writable"],
    ] as const) {
      declare(p);
      await expect(checkMounts([mountOf(p)], tctx)).rejects.toThrow(`isn't allowed: ${reason}.`);
    }
  });

  test("nothing else under the host home is newly allowed", async () => {
    const ssh = path.join(hostHome, ".ssh");
    declare(ssh);
    await expect(checkMounts([mountOf(ssh)], tctx)).rejects.toThrow(
      "it isn't one of the agent's allowed mounts",
    );
  });
});

// Spec §6.5: the GitHub skill class `join(realpath(<FH>/state/library/github), <id>, <sha>[, <name>])`.
describe("GitHub skills", () => {
  let hostHome: string;
  let gh: string;
  let gctx: MountCheckContext;
  const mountOf = (source: string, readOnly = true) => ({ source, target: source, readOnly });
  const declare = (...p: string[]) => {
    gctx = { ...gctx, skillPaths: p };
  };
  const reason = (src: string, why: string) => `Mount ${src} isn't allowed: ${why}.`;
  const IN_FACTORY =
    "it is inside FACTORY_HOME and isn't this agent's workdir, a registered skill or the plugin store";

  beforeEach(() => {
    hostHome = tmp("host-home-");
    const factory = path.join(hostHome, "open-factory");
    gh = path.join(factory, "state/library/github");
    const workdir = path.join(factory, "agents/lead");
    const pluginsDir = path.join(factory, "state/agents/lead/plugins-config/plugins");
    for (const d of [
      path.join(gh, "acme-skills/abc123/grilling"),
      workdir,
      pluginsDir,
      path.join(factory, "state/agents/bob/x"),
    ])
      mkdirSync(d, { recursive: true });
    mkdirSync(path.join(hostHome, ".ssh/acme-skills/abc123/grilling"), { recursive: true });
    const cliBundle = path.join(tmp("cli-"), "open-factory.js");
    writeFileSync(cliBundle, "//");
    gctx = {
      workdir,
      grantedPaths: [],
      skillPaths: [],
      templateSkillPaths: [],
      templateDir: path.join(factory, "templates/t"),
      declaredMarketplaceDirs: [],
      pluginsDir,
      cliBundle,
      factoryHome: factory,
      home: hostHome,
      dockerSockets: [],
    };
  });

  test("a skill folder, and a whole-repo checkout, mount read-only at their real path", async () => {
    const named = path.join(gh, "acme-skills/abc123/grilling");
    const whole = path.join(gh, "acme-skills/abc123");
    for (const p of [named, whole]) {
      declare(p);
      await expect(checkMounts([mountOf(p)], gctx)).resolves.toEqual([mountOf(p)]);
      await expect(checkMounts([mountOf(p, false)], gctx)).rejects.toThrow(MountRefusedError);
    }
  });

  test("a github checkout that isn't a registered skill isn't mounted", async () => {
    const p = path.join(gh, "acme-skills/abc123/grilling");
    await expect(checkMounts([mountOf(p)], gctx)).rejects.toThrow(
      reason(p, "it isn't one of the agent's allowed mounts"),
    );
  });

  test("state/library/github replaced by a link to ~/.ssh is refused", async () => {
    rmSync(gh, { recursive: true });
    symlinkSync(path.join(hostHome, ".ssh"), gh);
    const p = path.join(gh, "acme-skills/abc123/grilling");
    declare(p);
    await expect(checkMounts([mountOf(p)], gctx)).rejects.toThrow(MountRefusedError);
  });

  test("state/library replaced by a link into state/agents is refused", async () => {
    const lib = path.join(gctx.factoryHome, "state/library");
    const bob = path.join(gctx.factoryHome, "state/agents/bob");
    mkdirSync(path.join(bob, "github/acme-skills/abc123/grilling"), { recursive: true });
    rmSync(lib, { recursive: true });
    symlinkSync(bob, lib);
    const p = path.join(lib, "github/acme-skills/abc123/grilling");
    declare(p);
    await expect(checkMounts([mountOf(p)], gctx)).rejects.toThrow(IN_FACTORY);
  });

  test("a <sha> dir replaced by a link to state/agents/bob is refused", async () => {
    const sha = path.join(gh, "acme-skills/abc123");
    rmSync(sha, { recursive: true });
    symlinkSync(path.join(gctx.factoryHome, "state/agents/bob"), sha);
    for (const p of [sha, path.join(sha, "x")]) {
      declare(p);
      await expect(checkMounts([mountOf(p)], gctx)).rejects.toThrow(IN_FACTORY);
    }
  });

  test("one level up (<id>), the github root, state/library and state/ are refused", async () => {
    const factory = gctx.factoryHome;
    for (const [p, why] of [
      [path.join(gh, "acme-skills"), IN_FACTORY],
      [gh, IN_FACTORY],
      [path.join(factory, "state/library"), IN_FACTORY],
      [path.join(factory, "state"), "it is the factory state directory"],
      [path.join(gh, "acme-skills/abc123/grilling/deeper"), IN_FACTORY],
    ] as const) {
      mkdirSync(p, { recursive: true });
      declare(p);
      await expect(checkMounts([mountOf(p)], gctx)).rejects.toThrow(reason(p, why));
    }
  });
});
