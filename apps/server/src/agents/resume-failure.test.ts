import { expect, test } from "vitest";
import { classifyResumeFailure } from "./resume-failure.ts";

// "No conversation found" is the S0 fixture (verified). The two 400s are documented by the Agent SDK, unverified.
test.each([
  ["No conversation found with session ID: x", undefined, "unrecoverable"],
  ['400 {"error":{"message":"… diagnostics.previous_message_id …"}}', 400, "unrecoverable"],
  ["API Error: 400 Could not process image", 400, "unrecoverable"],
  ["API Error: 400 Could not process image", undefined, "unrecoverable"],
  ["Could not process image", 500, "ordinary"],
  ["Connection reset", undefined, "ordinary"],
] as const)("classify %s", (t, s, want) => expect(classifyResumeFailure(t, s)).toBe(want));
