import { afterAll, beforeAll, expect, test } from "vitest";
import { createTestDb } from "../test/helpers.ts";
import { createPrincipal } from "./principal-store.ts";
import { resolveText, UnknownMentionsError } from "./principal-text.ts";

let t: Awaited<ReturnType<typeof createTestDb>>;
let ada: Awaited<ReturnType<typeof createPrincipal>>;
beforeAll(async () => {
  t = await createTestDb();
  ada = await createPrincipal(t.db, "agent", "ada");
});
afterAll(async () => t.close());

test("an agent's plain @handle is stored as a mention", async () => {
  const r = await resolveText(t.db, "ask @ada about it", "agent");
  expect(r.text).toBe(`ask <@${ada.ref}> about it`);
  expect(r.refs).toEqual([ada.ref]);
  expect(r.warnings).toEqual([
    `Plain mention detected: @ada was resolved to <@${ada.ref}|ada>. Mention as <@ref|handle>.`,
  ]);
});

test("an unknown ref throws UnknownMentionsError naming it", async () => {
  const err = await resolveText(t.db, `hi <@${ada.ref}> and <@zzzzzzzz>`, "agent").catch((e) => e);
  expect(err).toBeInstanceOf(UnknownMentionsError);
  expect((err as UnknownMentionsError).refs).toEqual(["zzzzzzzz"]);
  expect((err as UnknownMentionsError).message).toContain("<@zzzzzzzz>");
});

test("a human's plain @handle stays text", async () => {
  const r = await resolveText(t.db, "ask @ada about it", "human");
  expect(r).toEqual({ text: "ask @ada about it", refs: [], warnings: [] });
});

test("a mention with a label is stored as <@ref> for either writer", async () => {
  for (const writer of ["agent", "human"] as const) {
    const r = await resolveText(t.db, `<@${ada.ref}|old-name> go`, writer);
    expect([r.text, r.refs, r.warnings]).toEqual([`<@${ada.ref}> go`, [ada.ref], []]);
  }
});
