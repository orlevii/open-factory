import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, expect, test, vi } from "vitest";
import { ApiError } from "../errors.ts";
import { GitError } from "../library/git.ts";
import { libraryRoutes } from "./library.ts";

// No database: the route is mounted on a bare Fastify with the service stubbed, so only the view's error handling runs.
vi.mock("../auth/require-user.ts", () => ({
  requireUser: async (req: { user?: { handle: string } }) => {
    req.user = { handle: "or" };
  },
}));

const ID = "11111111-1111-4111-8111-111111111111";
const detail = {
  id: ID,
  kind: "github" as const,
  path: null,
  repo: "acme/x",
  subpath: null,
  branch: "main",
  pin: "a".repeat(40),
  committedAt: null,
  subject: null,
  state: "ready" as const,
  skills: ["tdd"],
  updateCommit: "b".repeat(40),
  updateAt: null,
  updateSubject: null,
  checkedAt: null,
  checkError: null,
  usedBy: { templates: 0, agents: 0 },
};

let app: ReturnType<typeof Fastify> | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** The source view with `updateView` failing as given. */
async function viewWith(updateView: () => Promise<never>) {
  const server = Fastify({ logger: false });
  app = server;
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  server.decorate("skillSources", {
    detailOf: async () => detail,
    updateView,
  } as never);
  await server.withTypeProvider<ZodTypeProvider>().register(libraryRoutes);
  return server.inject({ method: "GET", url: `/api/library/sources/${ID}` });
}

test("when the new commit can't be fetched, the view answers with the source and no update", async () => {
  const r = await viewWith(() => Promise.reject(new GitError("git failed: no such commit.", "")));
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ id: ID, pin: "a".repeat(40), update: null });
});

test("an ApiError from building the view also leaves the update out", async () => {
  const r = await viewWith(() => Promise.reject(new ApiError(400, "validation_error", "too big")));
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ id: ID, update: null });
});

test("an unexpected error from building the view is not swallowed", async () => {
  const r = await viewWith(() => Promise.reject(new TypeError("bug in the view")));
  expect(r.statusCode).toBe(500);
});
