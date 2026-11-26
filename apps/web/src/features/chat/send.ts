import { apiFetch, type RefusalCode, sendMessagesResponseSchema } from "@open-factory/shared";
import { refOfWho, whoHandle } from "@/features/session/who";

export type SendMessagesInput = {
  /** Agent slugs, the chat's own first. */
  to: string[];
  body: string;
  urgent: boolean;
  clientMessageId: string;
  attachments?: string[];
  signal?: AbortSignal;
};

/** `POST /api/messages` (I1 §6.6): one result per recipient. `clientMessageId` makes a retry
 *  idempotent for every recipient. */
export const sendMessages = (i: SendMessagesInput) =>
  apiFetch("/api/messages", {
    method: "POST",
    body: {
      to: i.to,
      body: i.body,
      urgent: i.urgent,
      clientMessageId: i.clientMessageId,
      ...(i.attachments?.length ? { attachments: i.attachments } : {}),
    },
    schema: sendMessagesResponseSchema,
    ...(i.signal ? { signal: i.signal } : {}),
  });

const WHY: Partial<Record<RefusalCode, string>> = {
  terminated: "terminated",
  archived: "archived",
  disabled: "disabled",
  not_found: "no such agent",
};

/** Why a recipient wasn't sent to, in a few words: "terminated", else the server's sentence. */
export const refusedBecause = (r: {
  code?: RefusalCode | undefined;
  reason?: string | undefined;
}) => (r.code && WHY[r.code]) ?? (r.reason?.replace(/\.$/, "") || "refused");

/** A result names its recipient as a tag, `<@ref|handle>` (the label as of the send). */
export const handleOfResult = (to: string) => whoHandle(to).toLowerCase();

/** Whether a result is for the chat's agent: by ref when the chat knows it, else by handle. */
export const isResultFor = (to: string, slug: string, ref: string | undefined) => {
  const named = refOfWho(to);
  return named !== undefined && ref !== undefined
    ? named === ref
    : handleOfResult(to) === slug.toLowerCase();
};
