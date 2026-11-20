/**
 * Spec §9.3: whether a `--resume` failure can ever succeed on retry. "No conversation found" is the S0 fixture
 * (verified). The two 400s (`diagnostics.previous_message_id`, `Could not process image`) are documented by the
 * Agent SDK and **unverified**: no fixture has seen them. Anything unclassified is ordinary (when unsure, don't wipe).
 */
export function classifyResumeFailure(
  text: string,
  apiErrorStatus?: number,
): "unrecoverable" | "ordinary" {
  if (text.includes("No conversation found with session ID")) return "unrecoverable";
  const is400 = apiErrorStatus === 400 || (apiErrorStatus === undefined && /\b400\b/.test(text));
  if (
    is400 &&
    (text.includes("diagnostics.previous_message_id") || text.includes("Could not process image"))
  )
    return "unrecoverable";
  return "ordinary";
}
