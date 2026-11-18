import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { notFoundBody } from "./errors.ts";

/** Serves the built SPA. Returns false (API-only) when the folder is missing. */
export async function registerStatic(
  app: FastifyInstance,
  webRoot: string | undefined,
): Promise<boolean> {
  if (!webRoot || !existsSync(path.join(webRoot, "index.html"))) {
    app.log.warn({ webRoot }, "web UI build not found; serving the API only");
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(notFoundBody));
    return false;
  }
  await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api"))
      return reply.sendFile("index.html");
    return reply.code(404).send(notFoundBody);
  });
  return true;
}
