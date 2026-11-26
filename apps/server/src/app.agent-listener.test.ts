import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { FakeDriver } from "./agents/testing/fake-driver.ts";
import { makeTestApp, signUp } from "./test/helpers.ts";

let h: Awaited<ReturnType<typeof makeTestApp>> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const mcpUrlOf = (cwd: string) => {
  const mcpJson = JSON.parse(readFileSync(path.join(cwd, ".mcp.json"), "utf8"));
  return new URL(mcpJson.mcpServers.factory.url);
};

test("spec §5.3: a boot wake starts the agent with .mcp.json pointing at an agent listener that is already listening", async () => {
  h = await makeTestApp({ harnessDriver: new FakeDriver() });
  const a = await h.seedAgent({ slug: "ada" });
  const u = await signUp(h.app, { handle: "or" });
  // Written behind the first app's back: only the next boot's reconciliation can wake `ada` for it.
  await h.sql`insert into messages (id, kind, from_id, to_id, body,recipient_ids) values ('boot-1', 'message', ${u.user.id}, ${a.id}, 'wake at boot', ${[a.id]})`;
  await h.app.close();

  const probe = new FakeDriver();
  const seenAtStart: { port: number; status: number }[] = [];
  const start = probe.start.bind(probe);
  // FACTORY_AGENT_PORT=0: had the listener not been bound before reconciliation, .mcp.json would carry port 0. The
  // probe is sent from the moment Claude would connect.
  const pending: Promise<void>[] = [];
  probe.start = (spec, opts) => {
    const url = mcpUrlOf(spec.cwd);
    pending.push(
      fetch(`${url.origin}/api/status`).then((r) => {
        seenAtStart.push({ port: Number(url.port), status: r.status });
      }),
    );
    return start(spec, opts);
  };
  const next = await h.reopen({ harnessDriver: probe });
  await (await next.app.runtimes.bySlug("ada"))?.settled();
  await Promise.all(pending);

  expect(probe.starts).toHaveLength(1);
  expect(probe.last.spec.slug).toBe("ada");
  expect(seenAtStart).toEqual([{ port: next.app.agentListener.port, status: 200 }]);
  expect(mcpUrlOf(probe.last.spec.cwd).toString()).toBe(
    `http://127.0.0.1:${next.app.agentListener.port}/mcp`,
  );
});
