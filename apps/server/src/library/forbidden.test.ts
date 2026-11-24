import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MSG } from "@open-factory/shared";
import { beforeEach, describe, expect, test } from "vitest";
import { FieldError } from "../errors.ts";
import { checkSkillFolder, forbiddenSet } from "./forbidden.ts";

const tmp = (p: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), p)));

let home: string;
let factoryHome: string;
let sock: string;
let ctx: { home: string; factoryHome: string; dockerSockets: string[] };

beforeEach(() => {
  home = tmp("of-forbidden-home-");
  factoryHome = path.join(home, "open-factory");
  mkdirSync(path.join(factoryHome, "state"), { recursive: true });
  mkdirSync(path.join(home, "code/skills"), { recursive: true });
  sock = path.join(tmp("of-sock-"), "docker.sock");
  writeFileSync(sock, "");
  ctx = { home, factoryHome, dockerSockets: [sock] };
});

const refusal = async (real: string, c = ctx) => {
  const err = await checkSkillFolder(real, c).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FieldError);
  return (err as FieldError).message;
};

describe("forbiddenSet", () => {
  test("names the home, FACTORY_HOME, its state and each Docker socket", async () => {
    const set = await forbiddenSet(ctx);
    const named = (name: string) => set.filter((f) => f.name === name).map((f) => f.path);
    expect(named("the host home directory")).toContain(home);
    expect(named("FACTORY_HOME")).toContain(factoryHome);
    expect(named("the factory state directory")).toContain(path.join(factoryHome, "state"));
    expect(named("a Docker socket")).toContain(sock);
  });

  test("a linked spelling of a path is forbidden under its real path too", async () => {
    const alias = path.join(tmp("of-alias-"), "fh");
    symlinkSync(factoryHome, alias);
    const set = await forbiddenSet({ ...ctx, factoryHome: alias });
    const paths = set.filter((f) => f.name === "FACTORY_HOME").map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining([alias, factoryHome]));
  });
});

describe("checkSkillFolder", () => {
  test("allows a folder under the home that isn't the factory's", async () => {
    await expect(checkSkillFolder(path.join(home, "code/skills"), ctx)).resolves.toBeUndefined();
  });

  test("refuses the home and its ancestors with the home message", async () => {
    expect(await refusal(home)).toBe(MSG.folderHome);
    expect(await refusal(path.dirname(home))).toBe(MSG.folderHome);
  });

  test("refuses FACTORY_HOME, anything under it and its ancestors with the factory message", async () => {
    const elsewhere = tmp("of-fh-");
    const c = { ...ctx, factoryHome: path.join(elsewhere, "deep/fh") };
    mkdirSync(path.join(c.factoryHome, "x"), { recursive: true });
    expect(await refusal(c.factoryHome, c)).toBe(MSG.folderFactory);
    expect(await refusal(path.join(c.factoryHome, "x"), c)).toBe(MSG.folderFactory);
    expect(await refusal(path.join(elsewhere, "deep"), c)).toBe(MSG.folderFactory);
    expect(await refusal(elsewhere, c)).toBe(MSG.folderFactory);
  });

  test("refuses a path under FACTORY_HOME even when the factory sits inside the home", async () => {
    mkdirSync(path.join(factoryHome, "agents/bob"), { recursive: true });
    expect(await refusal(path.join(factoryHome, "agents/bob"))).toBe(MSG.folderFactory);
    expect(await refusal(path.join(factoryHome, "state"))).toBe(MSG.folderFactory);
  });

  test("refuses the root, a Docker socket and its ancestors with the generic message", async () => {
    expect(await refusal("/")).toBe(MSG.folderShare);
    expect(await refusal(sock)).toBe(MSG.folderShare);
    expect(await refusal(path.dirname(sock))).toBe(MSG.folderShare);
  });
});
