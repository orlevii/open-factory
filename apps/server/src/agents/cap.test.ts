import { expect, test } from "vitest";
import { CAP_BYTES, capPayload } from "./cap.ts";

test("short payloads pass through without a truncated map", () => {
  expect(capPayload({ type: "assistant_text", text: "hi" })).toEqual({ payload: { text: "hi" } });
});

test("long strings are cut on a code-point boundary and recorded by path", () => {
  const big = `${"a".repeat(CAP_BYTES - 1)}é${"b".repeat(10)}`; // é is 2 bytes and straddles the cap
  const { payload, truncated } = capPayload({
    type: "tool_result",
    toolUseId: "t",
    content: big,
    isError: false,
  });
  const content = payload.content as string;
  expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(CAP_BYTES);
  expect(content.endsWith("a")).toBe(true); // é not split
  expect(truncated).toEqual({ content: Buffer.byteLength(big, "utf8") });
});

test("nested strings (tool input) are capped too", () => {
  const { truncated } = capPayload({
    type: "tool_call",
    toolUseId: "t",
    name: "Write",
    input: { content: "x".repeat(CAP_BYTES + 5) },
  });
  expect(truncated).toEqual({ "input.content": CAP_BYTES + 5 });
});
