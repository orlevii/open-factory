import { fromNodeHeaders } from "better-auth/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import { principalById } from "../principals/principal-store.ts";

export interface RequestUser {
  id: string;
  email: string;
  name: string;
  handle: string;
  ref: string;
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
  const u = session.user as {
    id: string;
    email: string;
    name: string;
    disabledAt?: Date | string | null;
  };
  // S10 §9.4: a disabled user is signed out on every request, even if a session row survived.
  if (u.disabledAt) return null;
  const principal = await principalById(request.server.db, u.id);
  if (!principal) return null;
  return { id: u.id, email: u.email, name: u.name, handle: principal.handle, ref: principal.ref };
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await getUser(request);
  if (!user) {
    return reply.code(401).send({ error: { code: "unauthorized", message: "Not signed in" } });
  }
  request.user = user;
}
