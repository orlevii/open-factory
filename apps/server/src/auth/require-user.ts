import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";

export interface RequestUser {
  id: string;
  email: string;
  name: string;
  handle: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: RequestUser;
  }
}

/** The one session check: better-auth getSession handles both cookie and Authorization: Bearer. */
export async function getUser(request: FastifyRequest): Promise<RequestUser | null> {
  const session = await request.server.auth.api.getSession({
    headers: fromNodeHeaders(request.headers),
  });
  if (!session) return null;
  const u = session.user as { id: string; email: string; name: string; handle: string };
  return { id: u.id, email: u.email, name: u.name, handle: u.handle };
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await getUser(request);
  if (!user) {
    return reply.code(401).send({ error: { code: "unauthorized", message: "Not signed in" } });
  }
  request.user = user;
}
