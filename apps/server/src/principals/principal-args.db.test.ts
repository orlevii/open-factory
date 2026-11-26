import { plainTagWarning } from "@open-factory/shared/tags";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { seedTestPrincipal } from "../test/principals.ts";
import { type ArgResolution, resolveArg, resolveArgs } from "./principal-args.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let dev: Awaited<ReturnType<typeof seedTestPrincipal>>;
beforeAll(async () => {
  t = await createTestDb();
  dev = await seedTestPrincipal(t.db, "agent", "dev");
});
afterAll(async () => t.close());

const warning = (written: string) => plainTagWarning({ written, ref: dev.ref, handle: dev.handle });

test.each<[string, (ref: string) => string, (ref: string) => ArgResolution]>([
  ["a full tag with a stale handle", (r) => `<@${r}|old>`, () => ({ kind: "principal", p: dev })],
  ["a tag without a handle", (r) => ` <@${r}> `, () => ({ kind: "principal", p: dev })],
  ["a bare ref in capitals", (r) => r.toUpperCase(), () => ({ kind: "principal", p: dev })],
  ["@handle", () => "@dev", () => ({ kind: "principal", p: dev, warning: warning("@dev") })],
  ["a handle", () => "dev", () => ({ kind: "principal", p: dev, warning: warning("@dev") })],
  [
    "a handle written in a tag's place",
    () => "<@dev>",
    () => ({ kind: "principal", p: dev, warning: warning("<@dev>") }),
  ],
  [
    "a tag with an unknown ref",
    () => "<@zzzzzzzz>",
    () => ({ kind: "unknown_ref", ref: "zzzzzzzz" }),
  ],
  ["a channel", () => "#ops", () => ({ kind: "channel", name: "#ops" })],
  ["a reserved name", () => "@me", () => ({ kind: "reserved", name: "me" })],
  ["an unknown name", () => "ghost", () => ({ kind: "none", name: "ghost" })],
  [
    "an 8-character name that is no ref",
    () => "zzzzzzzz",
    () => ({ kind: "none", name: "zzzzzzzz" }),
  ],
])("%s resolves as expected", async (_name, raw, expected) => {
  expect(await resolveArg(t.db, raw(dev.ref))).toEqual(expected(dev.ref));
});

test("a batch resolves every argument in order", async () => {
  const out = await resolveArgs(t.db, [`<@${dev.ref}>`, "ghost", "#ops"]);
  expect(out.map((r) => r.kind)).toEqual(["principal", "none", "channel"]);
});
