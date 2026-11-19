import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { inCidr } from "./bind-hosts.ts";
import type { AgentTokens } from "./tokens.ts";

export const AGENT_BODY_LIMIT = 512 * 1024;

export interface AgentListenerInput {
  hosts: string[];
  port: number;
  allowedSources: string[];
  version: string;
  tokens: AgentTokens;
  isArchived(agentId: string): Promise<boolean>;
  mcp: (req: Request, agentId: string) => Promise<Response>;
  log: FastifyBaseLogger;
}

declare module "fastify" {
  interface FastifyRequest {
    agentId?: string;
  }
}

const unauthorized = { error: { code: "unauthorized", message: "Unauthorized" } };

function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer (\S+)$/i.exec(header ?? "");
  return m?.[1];
}

function buildInstance(i: AgentListenerInput, allowed: (addr: string | undefined) => boolean) {
  const app: FastifyInstance = Fastify({
    // The token travels in this header; no log line may carry it.
    loggerInstance: i.log.child({}, { redact: ["req.headers.authorization"] } as never),
    bodyLimit: AGENT_BODY_LIMIT,
  });
  // Keep the body raw so the MCP SDK parses it itself.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );
  app.decorateRequest("agentId", undefined);

  // 1. Remote address (the connection is also closed before parsing, see `listenOne`).
  app.addHook("onRequest", async (req, reply) => {
    if (!allowed(req.socket.remoteAddress)) {
      req.raw.destroy();
      return reply.hijack();
    }
  });
  // 2. Origin: browsers send one on cross-origin POSTs; Claude's MCP client sends none.
  app.addHook("onRequest", async (req, reply) => {
    if (req.headers.origin !== undefined) {
      return reply
        .code(403)
        .send({ error: { code: "forbidden_origin", message: "Origin not allowed" } });
    }
  });
  // 3. Token, on POST /mcp only.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "POST" || req.routeOptions.url !== "/mcp") return;
    const id = i.tokens.verify(bearer(req.headers.authorization));
    if (!id || (await i.isArchived(id.agentId))) return reply.code(401).send(unauthorized);
    req.agentId = id.agentId;
  });

  app.get("/api/status", async () => ({ version: i.version }));
  const notAllowed = async (
    _req: unknown,
    reply: { code(n: number): { send(b: unknown): unknown } },
  ) =>
    reply.code(405).send({ error: { code: "method_not_allowed", message: "Method not allowed" } });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  app.post("/mcp", async (req, reply) => {
    const agentId = req.agentId;
    if (!agentId) return reply.code(401).send(unauthorized);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || k === "content-length" || k === "host") continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const request = new Request(`http://agent.local${req.url}`, {
      method: "POST",
      headers,
      body,
    });
    const res = await i.mcp(request, agentId);
    reply.status(res.status);
    res.headers.forEach((value, key) => {
      if (key !== "content-length" && key !== "transfer-encoding") reply.header(key, value);
    });
    return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : null);
  });
  return app;
}

/** The agent listener (spec §5.1): one small Fastify instance per bind address, same routes and hooks. */
export async function startAgentListener(
  i: AgentListenerInput,
): Promise<{ port: number; close(): Promise<void> }> {
  const allowed = (addr: string | undefined) =>
    addr !== undefined && i.allowedSources.some((c) => inCidr(addr, c));
  const started: FastifyInstance[] = [];
  const closeAll = async () => {
    await Promise.all(started.map((a) => a.close()));
  };
  let port = i.port;
  try {
    for (const host of i.hosts) {
      const app = buildInstance(i, allowed);
      // Refuse a foreign source before a single byte is parsed.
      app.server.on("connection", (socket) => {
        if (!allowed(socket.remoteAddress)) socket.destroy();
      });
      try {
        await app.listen({ host, port });
      } catch (err) {
        await app.close().catch(() => undefined);
        throw new Error(
          `agent listener could not bind ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      started.push(app);
      const addr = app.server.address();
      if (port === 0 && addr && typeof addr === "object") port = addr.port;
    }
  } catch (err) {
    await closeAll();
    throw err;
  }
  return { port, close: closeAll };
}
