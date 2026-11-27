import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schema } from "@open-factory/db";
import type { PrincipalItem, ServerMessage } from "@open-factory/shared";
import { afterEach, beforeEach, expect, test } from "vitest";
import { makeTestApp, signUp } from "../test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>>;
let or: Awaited<ReturnType<typeof signUp>>;
let frames: ServerMessage[];

beforeEach(async () => {
  h = await makeTestApp();
  or = await signUp(h.app, { handle: "or" });
  const dir = path.join(h.factoryHome, "templates/lead");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "template.yaml"),
    "name: lead\ndisplay_name: Lead\nruntime: local\n",
  );
  writeFileSync(path.join(dir, "AGENTS.md"), "# Lead\n");
  const credId = randomUUID();
  await h.db.insert(schema.credentials).values({
    id: credId,
    name: "work",
    kind: "oauth_token",
    valueEnc: h.app.vault.seal("tok", `credentials:${credId}`),
  });
  frames = [];
  h.app.bus.subscribeAll((m) => frames.push(m));
});
afterEach(() => h.close());

const newAgent = () => ({
  template: "lead",
  description: "",
  reportsTo: or.user.ref,
  credential: "work",
});
const send = (method: "PATCH" | "POST", url: string, payload: object) =>
  h.app.inject({ method, url, headers: { cookie: or.cookie }, payload });
const updates = (): PrincipalItem[] =>
  frames.flatMap((f) => (f.type === "principal_updated" ? [f.principal] : []));

test("renaming an agent returns 200 and publishes principal_updated with the new handle", async () => {
  const dev = await h.seedAgent({ handle: "dev" });
  const ref = await h.refOf("dev");
  const res = await send("PATCH", `/api/agents/${ref}`, { handle: "builder" });
  expect(res.statusCode).toBe(200);
  expect(res.json().agent.handle).toBe("builder");
  expect(updates()).toEqual([
    expect.objectContaining({ id: dev.id, ref, kind: "agent", handle: "builder", state: "live" }),
  ]);
});

test("changing an agent's colour publishes principal_updated with the new colour", async () => {
  const dev = await h.seedAgent({ handle: "dev" });
  const res = await send("PATCH", `/api/agents/${await h.refOf("dev")}`, { color: 5 });
  expect(res.statusCode).toBe(200);
  expect(updates()).toEqual([
    expect.objectContaining({ id: dev.id, avatar: expect.objectContaining({ color: 5 }) }),
  ]);
});

test("renaming to a taken handle is 409 with the field error and publishes nothing", async () => {
  await h.seedAgent({ handle: "dev" });
  await h.seedAgent({ handle: "other" });
  const res = await send("PATCH", `/api/agents/${await h.refOf("dev")}`, { handle: "other" });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.fields).toEqual({ handle: "Another agent or person has this handle" });
  expect(updates()).toEqual([]);
});

test("renaming an agent to a person's handle is 409", async () => {
  await h.seedAgent({ handle: "dev" });
  const res = await send("PATCH", `/api/agents/${await h.refOf("dev")}`, { handle: "or" });
  expect(res.statusCode).toBe(409);
});

test.each([
  ["me", "Reserved for the factory"],
  ["a", "Use 2 to 40 characters"],
  ["Has_Caps", "Use lowercase letters, numbers and hyphens"],
  ["-lead", "Start and end with a letter or number"],
])("renaming an agent to %s is 400 with the field message", async (handle, message) => {
  await h.seedAgent({ handle: "dev" });
  const res = await send("PATCH", `/api/agents/${await h.refOf("dev")}`, { handle });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.fields).toEqual({ handle: message });
});

test("after a rename the old handle is free for a new agent", async () => {
  await h.seedAgent({ handle: "dev" });
  await send("PATCH", `/api/agents/${await h.refOf("dev")}`, { handle: "builder" });
  const made = await send("POST", "/api/agents", {
    ...newAgent(),
    handle: "dev",
    displayName: "New dev",
  });
  expect(made.statusCode, made.body).toBe(201);
});

test("creating an agent publishes principal_updated with its mention data", async () => {
  const made = await send("POST", "/api/agents", {
    ...newAgent(),
    handle: "fresh",
    displayName: "Fresh",
  });
  expect(made.statusCode, made.body).toBe(201);
  expect(updates()).toEqual([
    expect.objectContaining({ handle: "fresh", name: "Fresh", kind: "agent", state: "live" }),
  ]);
});

test("archiving and unarchiving an agent each publish its new state", async () => {
  await h.seedAgent({ handle: "dev" });
  const ref = await h.refOf("dev");
  await send("POST", `/api/agents/${ref}/archive`, {});
  await send("POST", `/api/agents/${ref}/unarchive`, {});
  expect(updates().map((p) => p.state)).toEqual(["archived", "live"]);
});

test("a rename refreshes the loaded runtime without restarting it, so its refusals name the new handle", async () => {
  await h.seedAgent({ handle: "dev" });
  const ref = await h.refOf("dev");
  const rt = await h.app.runtimes.byRef(ref);
  if (!rt) throw new Error("no runtime");
  await send("PATCH", `/api/agents/${ref}`, { handle: "builder" });
  expect(frames.some((f) => f.type === "agent_status" && f.restartPending)).toBe(false);
  rt.markArchived(); // the runtime now refuses input; archiving through the API would refresh it and hide a stale handle
  const res = await send("POST", `/api/agents/${ref}/input`, {
    text: "hi",
    clientMessageId: crypto.randomUUID(),
  });
  expect(res.statusCode).toBe(409);
  expect(res.body).toContain("@builder");
  expect(res.body).not.toContain("@dev");
});

test("PATCH /api/me changes name and handle and publishes", async () => {
  const res = await send("PATCH", "/api/me", { name: "Or Levi", handle: "orl" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ name: "Or Levi", handle: "orl", ref: or.user.ref });
  const me = await h.app.inject({ method: "GET", url: "/api/me", headers: { cookie: or.cookie } });
  expect(me.json()).toMatchObject({ name: "Or Levi", handle: "orl" });
  expect(updates()).toEqual([
    expect.objectContaining({ id: or.user.id, kind: "human", handle: "orl", name: "Or Levi" }),
  ]);
});

test("PATCH /api/me to a taken handle is 409 and changes neither field", async () => {
  await h.seedAgent({ handle: "dev" });
  const res = await send("PATCH", "/api/me", { name: "Changed", handle: "dev" });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.fields.handle).toBe("Another agent or person has this handle");
  const me = await h.app.inject({ method: "GET", url: "/api/me", headers: { cookie: or.cookie } });
  expect(me.json().name).toBe(or.user.name);
  expect(updates()).toEqual([]);
});

test("PATCH /api/me refuses an empty name and unknown fields, and needs a session", async () => {
  expect((await send("PATCH", "/api/me", { name: "  " })).json().error.fields.name).toBe(
    "Enter a name",
  );
  expect((await send("PATCH", "/api/me", { email: "x@y.z" })).statusCode).toBe(400);
  const anon = await h.app.inject({ method: "PATCH", url: "/api/me", payload: { name: "x" } });
  expect(anon.statusCode).toBe(401);
});

test("signing up publishes the new person", async () => {
  frames.length = 0;
  const pat = await signUp(h.app, { handle: "pat" });
  expect(updates()).toEqual([
    expect.objectContaining({ id: pat.user.id, kind: "human", handle: "pat", state: "live" }),
  ]);
});

test("disabling and enabling a person each publish their new state", async () => {
  const pat = await signUp(h.app, { handle: "pat" });
  frames.length = 0;
  await send("POST", `/api/users/${pat.user.id}/disable`, {});
  await send("POST", `/api/users/${pat.user.id}/enable`, {});
  expect(updates().map((p) => [p.handle, p.state])).toEqual([
    ["pat", "disabled"],
    ["pat", "live"],
  ]);
});

test("terminating a spawned agent publishes it as terminated", async () => {
  const lead = await h.seedAgent({ handle: "lead" });
  const kid = await h.seedAgent({ handle: "kid" });
  await h.sql`update agents set kind = 'ephemeral', reports_to = ${lead.id} where id = ${kid.id}`;
  const res = await send("POST", `/api/agents/${await h.refOf("kid")}/terminate`, {});
  expect(res.statusCode).toBe(200);
  expect(updates().map((p) => [p.handle, p.state])).toEqual([["kid", "terminated"]]);
});
