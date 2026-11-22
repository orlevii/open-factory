import { sendMessageBodySchema } from "@open-factory/shared";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { expect, test } from "vitest";
import { z } from "zod";
import { ApiError, FieldError, registerErrorHandlers } from "./errors.ts";

test("validation errors carry fields; ApiError extras are rendered", async () => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  app.post(
    "/v",
    { schema: { body: z.object({ slug: z.string().min(3, "Too short"), name: z.string() }) } },
    async () => ({}),
  );
  app.post("/f", async () => {
    throw new FieldError("slug", "That slug is taken.", "slug_taken");
  });
  app.post("/e", async () => {
    throw new ApiError(409, "credential_in_use", "Used by @a.", { usedBy: ["a"] });
  });
  const v = await app.inject({ method: "POST", url: "/v", payload: { slug: "a" } });
  expect(v.statusCode).toBe(400);
  expect(v.json().error.fields).toEqual({ slug: "Too short", name: expect.any(String) });
  const f = await app.inject({ method: "POST", url: "/f" });
  expect(f.statusCode).toBe(409);
  expect(f.json()).toEqual({
    error: {
      code: "slug_taken",
      message: "That slug is taken.",
      fields: { slug: "That slug is taken." },
    },
  });
  const e = await app.inject({ method: "POST", url: "/e" });
  expect(e.json()).toEqual({
    error: { code: "credential_in_use", message: "Used by @a.", usedBy: ["a"] },
  });
});

test("a validation message is the issue's own sentence, never the schema path", async () => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  app.post("/m", { schema: { body: sendMessageBodySchema } }, async () => ({}));
  app.get(
    "/p/:n",
    { schema: { params: z.object({ n: z.coerce.number().int("Must be a whole number") }) } },
    async () => ({}),
  );
  const big = await app.inject({
    method: "POST",
    url: "/m",
    payload: { body: "x".repeat(70_000) },
  });
  expect(big.json().error.message).toBe("Message is larger than 64 KB");
  const p = await app.inject({ method: "GET", url: "/p/1.5" });
  expect(p.json().error.message).toBe("Must be a whole number");
  expect(p.json().error.message).not.toMatch(/\//);
});
