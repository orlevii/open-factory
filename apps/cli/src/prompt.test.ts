import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { createPrompt, PromptAborted } from "./prompt.ts";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (d) => {
    written += String(d);
  });
  return { input, output, written: () => written };
}

test("reads piped answers in order, including lines buffered together", async () => {
  const s = streams();
  const p = createPrompt(s.input, s.output);
  s.input.write("a@b.c\nsecret\n");
  expect(await p.ask("Email")).toBe("a@b.c");
  expect(await p.askHidden("Password")).toBe("secret");
  p.close();
  expect(s.written()).toContain("Email: ");
  expect(s.written()).toContain("Password: ");
  expect(s.written()).not.toContain("secret");
});

test("ask falls back to the default on an empty answer", async () => {
  const s = streams();
  const p = createPrompt(s.input, s.output);
  s.input.write("\n");
  expect(await p.ask("Server URL", "http://localhost:3000")).toBe("http://localhost:3000");
  p.close();
});

test("EOF at a pending prompt rejects with PromptAborted; later prompts reject too", async () => {
  const s = streams();
  const p = createPrompt(s.input, s.output);
  s.input.write("a@b.c\n");
  expect(await p.ask("Email")).toBe("a@b.c");
  const pending = p.askHidden("Password");
  s.input.end();
  await expect(pending).rejects.toBeInstanceOf(PromptAborted);
  await expect(p.ask("Again")).rejects.toThrow("Aborted");
});
