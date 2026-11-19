// Live smoke for S3 (spec §13.3). Needs Postgres (pnpm compose up -d) and CLAUDE_CODE_OAUTH_TOKEN.
// Uses the real runtime, driver and Postgres store; bypasses only HTTP and auth. Model: haiku.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, MIGRATIONS_DIR, migrate } from "@open-factory/db";
import { createTestDatabase } from "@open-factory/db/testing";
import { createClaudeDriver } from "@open-factory/harness";
import type { AnyEvent } from "@open-factory/shared";
import { AgentRuntime } from "../src/agents/agent-runtime.ts";
import { EventBus } from "../src/agents/event-bus.ts";
import { EventStore } from "../src/agents/event-store.ts";
import { seedDevAgent } from "../src/agents/seed-dev.ts";
import { loadConfig } from "../src/config.ts";

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error("Set CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) first.");
  process.exit(1);
}
const tdb = await createTestDatabase();
await migrate(tdb.url, MIGRATIONS_DIR);
const { db, sql, close } = createDb(tdb.url);
const config = loadConfig({
  ...process.env,
  DATABASE_URL: tdb.url,
  FACTORY_SECRET_KEY: "s".repeat(40),
  FACTORY_HOME: mkdtempSync(path.join(tmpdir(), "of-smoke-")),
});
await sql`insert into users (id, name, email, handle) values ('smoke', 'Smoke', 'smoke@example.invalid', 'smoke')`;
const agent = await seedDevAgent(db, config);
const store = new EventStore(db);
const bus = new EventBus();
const log = { debug() {}, info: console.log, warn: console.warn, error: console.error };
const all: AnyEvent[] = [];
bus.subscribe("dev", (m) => {
  if (m.type === "session_event") {
    all.push(m.event.event);
    print(m.event.event);
  }
});
function print(e: AnyEvent) {
  const brief =
    e.type === "assistant_text"
      ? e.text.slice(0, 80)
      : e.type === "turn_end"
        ? `${e.terminalReason ?? ""} ${e.originKind ?? ""} ${e.command ?? ""}`
        : "";
  console.log(`  · ${e.type} ${brief}`);
}
const make = () =>
  new AgentRuntime({ agent, store, bus, driver: createClaudeDriver(log), config, log });
let rt = make();
await rt.init();
const send = (body: string, urgent = false) =>
  rt.sendMessage({ fromUserId: "smoke", fromHandle: "smoke", body, urgent });
const waitFor = async (pred: (e: AnyEvent) => boolean, from: number, ms = 120_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = all.slice(from).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
};
const step = async (name: string, fn: () => Promise<void>) => {
  console.log(`\n▶ ${name}`);
  await fn();
  console.log(`✓ ${name}`);
};
const isEnd = (e: AnyEvent) => e.type === "turn_end" && !e.originKind;

try {
  await step("send and reply", async () => {
    const from = all.length;
    await send("Remember the word HERON. Reply with just OK.");
    await waitFor(isEnd, from);
  });
  await step("compact shows a manual marker with token counts", async () => {
    const from = all.length;
    await rt.compact({ byHandle: "smoke" });
    const c = await waitFor((e) => e.type === "compacted", from);
    if (c.type !== "compacted" || c.trigger !== "manual" || !c.preTokens || !c.postTokens)
      throw new Error(JSON.stringify(c));
    await waitFor((e) => e.type === "turn_end" && e.command === "compact", from);
  });
  await step("urgent mid-tool interrupts a foreground sleep", async () => {
    const from = all.length;
    await send("Run the Bash command `sleep 20` in the foreground, then reply DONE.");
    await waitFor((e) => e.type === "tool_call", from);
    await send("Urgent: stop and reply with just URGENT1.", true);
    await waitFor((e) => e.type === "turn_end" && e.isError, from);
    await waitFor((e) => e.type === "assistant_text" && e.text.includes("URGENT1"), from);
  });
  await step("urgent mid-generation", async () => {
    const from = all.length;
    await send("Write a 600-word essay about herons. No tools.");
    await waitFor((e) => e.type === "turn_started", from);
    await new Promise((r) => setTimeout(r, 1500));
    await send("Urgent: stop and reply with just URGENT2.", true);
    const ended = await waitFor((e) => e.type === "turn_end", from);
    console.log(`  interrupted turn ended with: ${JSON.stringify(ended)}`); // record terminalReason in the PR
    await waitFor((e) => e.type === "assistant_text" && e.text.includes("URGENT2"), from);
  });
  await step(
    "urgent just after a natural result (stray interrupt on an idle process)",
    async () => {
      const from = all.length;
      await send("Reply with just PING.");
      await waitFor(isEnd, from);
      await send("Urgent: reply with just URGENT3.", true);
      await waitFor((e) => e.type === "assistant_text" && e.text.includes("URGENT3"), from);
    },
  );
  await step("stop, start again with --resume, and remember", async () => {
    await rt.stop();
    rt = make();
    await rt.init();
    const from = all.length;
    await send("What word did I ask you to remember? Reply with one word.");
    const started = await waitFor((e) => e.type === "process_started", from);
    if (started.type !== "process_started" || !started.resumed) throw new Error("not resumed");
    await waitFor((e) => e.type === "assistant_text" && /HERON/i.test(e.text), from);
  });
  console.log("\nSmoke passed.");
} finally {
  await rt.stop().catch(() => {});
  await close();
  await tdb.drop();
}
