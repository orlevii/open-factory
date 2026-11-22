import { slugSchema } from "@open-factory/shared";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import { bodyStream, UploadIdleError } from "../uploads/body-stream.ts";
import { UploadAgentEndedError, UploadLimitError } from "../uploads/service.ts";
import { IMAGE_TOO_LARGE, type Refusal } from "../uploads/sniff.ts";
import { MAX_UPLOAD_BYTES, UploadExistsError, UploadTooLargeError } from "../uploads/store.ts";
import { WorkspaceError } from "../workspace/safe-fs.ts";

const slugParams = z.object({ slug: slugSchema });
const uploadParams = z.object({ slug: slugSchema, id: z.string().min(1).max(64) });
const err = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message } });
const TOO_LARGE = "The file is larger than 20 MB.";
const UNSAFE_WORKSPACE =
  "The agent's .factory folder is a link or isn't a folder; the factory won't write through it.";
const WORKSPACE_GONE = "This agent's workspace no longer exists.";
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** The longest original name kept for the chip (characters, after decoding). */
const MAX_NAME_CHARS = 255;

const refusalCode = (r: Refusal) =>
  r.status === 415
    ? "unsupported_type"
    : r.reason === IMAGE_TOO_LARGE
      ? "image_too_large"
      : "empty_file";

/** `filename="…"` gets the safe ASCII form; `filename*` carries the original (RFC 6266). */
function disposition(type: "inline" | "attachment", storedPath: string, original: string) {
  const safe = storedPath
    .slice(storedPath.lastIndexOf("/") + 1)
    .replace(/^\d{8}-[0-9a-f-]{36}-/, "");
  // RFC 5987 attr-char: encodeURIComponent leaves ' ( ) * ! unescaped, and ' delimits the ext-value.
  const ext = encodeURIComponent(original).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${safe}"; filename*=UTF-8''${ext}`;
}

/**
 * U3 §13.5: uploads into an agent's workspace (D4: a raw body, the name in a header, no multipart dependency). Access
 * is the access to send that agent a message: a signed-in human, an agent that exists and hasn't ended. An unsent
 * upload is visible to its uploader only; a sent one is part of the session (any signed-in human may preview it).
 */
export const uploadsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("onRequest", requireUser);
  // A pass-through parser: the route streams the body itself and counts its bytes, so Fastify's bodyLimit (which a
  // stream parser bypasses) is not what caps it. Scoped to this plugin.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) =>
    done(null, payload),
  );

  const user = (req: { user?: { id: string } }) => {
    if (!req.user) throw new Error("requireUser did not set request.user");
    return req.user;
  };

  app.post("/api/agents/:slug/uploads", { schema: { params: slugParams } }, async (req, reply) => {
    // Review M7: another type was already consumed by Fastify's own parsers; say so instead of "empty".
    if (!String(req.headers["content-type"] ?? "").startsWith("application/octet-stream"))
      return err(
        reply,
        415,
        "unsupported_media_type",
        "Send the file as application/octet-stream.",
      );
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES)
      return err(reply, 413, "too_large", TOO_LARGE);
    const header = req.headers["x-upload-name"];
    let name: string;
    try {
      name = typeof header === "string" ? decodeURIComponent(header).normalize("NFC") : "";
    } catch {
      return err(reply, 400, "validation_error", "X-Upload-Name isn't valid percent-encoding.");
    }
    if (!name.trim()) return err(reply, 400, "validation_error", "X-Upload-Name is required.");
    // Review I2: C0/C1 controls (a NUL can't even be stored) are refused, not sanitized.
    if (CONTROL.test(name))
      return err(reply, 400, "validation_error", "The file name contains control characters.");
    if (name.length > MAX_NAME_CHARS)
      return err(reply, 400, "validation_error", "The file name is too long.");

    const agent = await app.store.agentBySlug(req.params.slug);
    if (!agent) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
    if (agent.terminatedAt)
      return err(reply, 409, "agent_terminated", `@${agent.slug} was terminated.`);
    if (agent.archivedAt) return err(reply, 409, "agent_archived", `@${agent.slug} is archived.`);

    try {
      const r = await app.uploads.create(agent, user(req).id, name, bodyStream(req.raw));
      if ("status" in r) return err(reply, r.status, refusalCode(r), r.reason);
      return reply.code(201).send(r);
    } catch (e) {
      // The rest of the body may be unread: close the connection after answering.
      reply.header("connection", "close");
      if (e instanceof UploadTooLargeError) return err(reply, 413, "too_large", TOO_LARGE);
      if (e instanceof UploadLimitError) return err(reply, 429, "too_many_uploads", e.message);
      if (e instanceof UploadIdleError) return err(reply, 408, "upload_stalled", e.message);
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return err(reply, 410, "workspace_gone", WORKSPACE_GONE);
      if (e instanceof UploadAgentEndedError) return err(reply, 409, e.code, e.message);
      if (e instanceof UploadExistsError) return err(reply, 409, "upload_exists", e.message);
      if (e instanceof WorkspaceError) {
        // The message reaches the chip: the server's absolute paths stay in the log (finding D16).
        req.log.warn({ err: e, agent: agent.slug }, "upload refused: unsafe workspace");
        return err(reply, 409, "unsafe_workspace", UNSAFE_WORKSPACE);
      }
      throw e;
    }
  });

  app.get(
    "/api/agents/:slug/uploads/:id",
    { schema: { params: uploadParams } },
    async (req, reply) => {
      const agent = await app.store.agentBySlug(req.params.slug);
      if (!agent) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      const row = await app.uploads.get(agent.id, req.params.id);
      if (!row || (row.messageId === null && row.uploaderId !== user(req).id))
        return err(reply, 404, "upload_not_found", "No such upload.");
      const file = await app.uploads.read(agent, row);
      if (file === "gone") return err(reply, 410, "workspace_gone", WORKSPACE_GONE);
      if (file === "changed")
        return err(reply, 409, "upload_changed", "The file changed on disk since it was uploaded.");
      return reply
        .header("content-type", file.mime)
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cache-control", "private, no-store")
        .header(
          "content-disposition",
          disposition(
            row.kind === "image" ? "inline" : "attachment",
            row.storedPath,
            row.originalName,
          ),
        )
        .send(file.data);
    },
  );

  app.delete(
    "/api/agents/:slug/uploads/:id",
    { schema: { params: uploadParams } },
    async (req, reply) => {
      const agent = await app.store.agentBySlug(req.params.slug);
      if (!agent) return err(reply, 404, "agent_not_found", `No agent named ${req.params.slug}`);
      const me = user(req).id;
      const row = await app.uploads.get(agent.id, req.params.id);
      if (!row || (row.messageId === null && row.uploaderId !== me))
        return err(reply, 404, "upload_not_found", "No such upload.");
      const outcome = await app.uploads.removeUnsent(agent.slug, row, me);
      if (outcome === "not_uploader")
        return err(
          reply,
          403,
          "not_uploader",
          "Only the person who uploaded a file can remove it.",
        );
      if (outcome === "already_sent")
        return err(reply, 409, "already_sent", "This file was sent with a message.");
      return reply.code(204).send();
    },
  );
};
