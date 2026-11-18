import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";

export async function authRoutes(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, app.config.publicUrl);
      const headers = fromNodeHeaders(request.headers);
      const hasBody = request.body !== undefined && request.body !== null;
      const req = new Request(url, {
        method: request.method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
      });
      const res = await app.auth.handler(req);
      reply.status(res.status);
      const cookies = res.headers.getSetCookie();
      res.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      if (cookies.length) reply.header("set-cookie", cookies);
      return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : null);
    },
  });
}
