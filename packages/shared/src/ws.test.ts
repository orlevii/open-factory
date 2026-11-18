import { expect, test } from "vitest";
import { clientMessageSchema, serverMessageSchema } from "./ws.ts";

test("parses client ping and rejects unknown types", () => {
  expect(clientMessageSchema.parse({ type: "ping" })).toEqual({ type: "ping" });
  expect(clientMessageSchema.safeParse({ type: "subscribe", topic: "x" }).success).toBe(false);
});

test("parses server messages", () => {
  expect(serverMessageSchema.parse({ type: "hello", userId: "u1" }).type).toBe("hello");
  expect(serverMessageSchema.parse({ type: "pong" }).type).toBe("pong");
  expect(serverMessageSchema.parse({ type: "error", code: "bad_message", message: "x" }).type).toBe(
    "error",
  );
});
