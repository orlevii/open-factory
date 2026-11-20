import path from "node:path";
import { buildBodySchema, imageLogSchema, imagesListSchema } from "@open-factory/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireUser } from "../auth/require-user.ts";
import { ApiError } from "../errors.ts";
import { ImageNameError, imageDir } from "../images/context.ts";
import { listImages } from "../images/status.ts";
import type { DockerClient } from "../runtime/docker/client.ts";

/** The name is validated by `imageDir` (grammar and containment), so a bad one is `invalid_image_name`, not a schema error. */
const params = z.object({ name: z.string() });

/** S10 §10.5: user image builds on the host's Docker daemon, human session only. */
export const imagesRoutes: FastifyPluginAsyncZod<{ docker: DockerClient }> = async (
  app,
  { docker },
) => {
  // onRequest, not preHandler: auth must come before validation (401 before 400).
  app.addHook("onRequest", requireUser);
  const imagesRoot = () => path.join(app.config.factoryHome, "images");

  const checkName = async (name: string) => {
    try {
      await imageDir(imagesRoot(), name);
    } catch (err) {
      if (err instanceof ImageNameError) throw new ApiError(400, "invalid_image_name", err.message);
      throw err;
    }
  };

  app.get("/api/images", { schema: { response: { 200: imagesListSchema } } }, async () => ({
    imagesDir: imagesRoot(),
    baseImage: app.config.defaultImage,
    images: await listImages(
      { docker, builder: app.images, imagesRoot: imagesRoot() },
      await app.templates.scan(),
    ),
  }));

  app.get(
    "/api/images/:name/log",
    { schema: { params, response: { 200: imageLogSchema } } },
    async (req) => app.images.log(req.params.name),
  );

  app.post(
    "/api/images/:name/build",
    { schema: { params, body: buildBodySchema.nullish() } },
    async (req, reply) => {
      const { name } = req.params;
      const pull = req.body?.pull ?? true;
      await checkName(name);
      const ndjson = (req.headers.accept ?? "").includes("application/x-ndjson");

      if (!ndjson) {
        app.images.build(name, { pull }).catch((err: unknown) => {
          req.log.error({ err, name }, "image build failed to start");
        });
        return reply.code(202).send({ state: "building" });
      }

      // Subscribe before `build()` (whose run registers after an await) so no line is missed; a build that is
      // already running is joined, and its lines so far are replayed in the same tick.
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, { "content-type": "application/x-ndjson" });
      const send = (o: object) => {
        if (!raw.destroyed && !raw.writableEnded) raw.write(`${JSON.stringify(o)}\n`);
      };
      const joined = app.images.running(name);
      const unsubscribe = app.images.subscribe(name, (line) => send({ line }));
      if (joined) for (const line of app.images.log(name).lines) send({ line });
      // A client disconnect only stops the stream; the build runs on (spec §10.5).
      raw.on("close", unsubscribe);
      try {
        const r = await app.images.build(name, { pull });
        send(r.state === "failed" ? { state: "failed", error: r.error } : { state: r.state });
      } catch (err) {
        send({ state: "failed", error: err instanceof Error ? err.message : String(err) });
      } finally {
        unsubscribe();
        raw.end();
      }
    },
  );
};
