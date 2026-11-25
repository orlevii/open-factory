import type { Db } from "@open-factory/db";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import { handleSignUp, signUpMutex } from "../users/sign-up-gate.ts";

export async function authRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, app.config.publicUrl);
      const headers = fromNodeHeaders(request.headers);
      // The body is re-serialized below, so the client's length no longer applies.
      headers.delete("content-length");
      // better-auth keys rate limits and session.ipAddress on X-Forwarded-For. Use the socket IP
      // so a client can't pick its own (behind a proxy this is the proxy's IP; see README).
      headers.set("x-forwarded-for", request.ip);
      const hasBody = request.body !== undefined && request.body !== null;
      const req = new Request(url, {
        method: request.method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
      });
      // The normalized path, exactly what better-auth matches (S10 §9.3, F2): dot-segment and %2e variants
      // land here too. The user.create.before backstop covers whatever this match misses.
      // update-user runs under the sign-up mutex too, so a user claim is never reclaimed while another user's insert is in
      // flight. The mutex is in-process and assumes one server process (ADR 0013); a multi-instance deployment needs a
      // Postgres advisory lock here as well.
      const signOut = request.method === "POST" && url.pathname === "/api/auth/sign-out";
      // Resolved before forwarding: a successful sign-out deletes the session. Spec I3 §5.4. A lookup failure never fails the sign-out.
      const session = signOut ? await app.auth.api.getSession({ headers }).catch(() => null) : null;
      const res =
        request.method === "POST" && url.pathname === "/api/auth/sign-up/email"
          ? await handleSignUp(
              { db, invites: app.invites, auth: app.auth, bus: app.bus, log: request.log },
              req,
              request.body,
            )
          : request.method === "POST" && url.pathname === "/api/auth/update-user"
            ? await signUpMutex.run("sign-up", () => app.auth.handler(req))
            : await app.auth.handler(req);
      if (session && res.ok) app.signIn.endFor(session.user.id);
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
