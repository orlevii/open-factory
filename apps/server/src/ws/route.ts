import websocket from "@fastify/websocket";
import { clientMessageSchema, type ServerMessage } from "@open-factory/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { trustedOrigins } from "../auth/origins.ts";
import { getUser } from "../auth/require-user.ts";

const unauthorized = (reply: FastifyReply) =>
  reply.code(401).send({ error: { code: "unauthorized", message: "Not signed in" } });

export const MAX_FRAME_BYTES = 64 * 1024;

export async function wsRoutes(app: FastifyInstance) {
  // ws defaults to 100 MiB frames, each JSON.parsed whole; client messages are tiny.
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  const allowed = new Set(trustedOrigins(app.config));

  async function checkUpgrade(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) return unauthorized(reply);
    if (origin === undefined && !/^Bearer\s+\S+/i.test(request.headers.authorization ?? ""))
      return unauthorized(reply);
    const user = await getUser(request);
    if (!user) return unauthorized(reply);
    request.user = user;
  }

  app.get("/api/ws", { websocket: true, preValidation: checkUpgrade }, (socket, request) => {
    const userId = request.user?.id;
    if (!userId) return socket.close(1008, "unauthorized");
    const send = (m: ServerMessage) => socket.send(JSON.stringify(m));
    socket.on("message", (raw) => {
      let parsed: ReturnType<typeof clientMessageSchema.safeParse>;
      try {
        parsed = clientMessageSchema.safeParse(JSON.parse(String(raw)));
      } catch {
        return send({ type: "error", code: "bad_message", message: "Message is not valid JSON" });
      }
      if (!parsed.success)
        return send({ type: "error", code: "bad_message", message: "Unknown message" });
      if (parsed.data.type === "ping") send({ type: "pong" });
    });
    send({ type: "hello", userId });
  });
}
