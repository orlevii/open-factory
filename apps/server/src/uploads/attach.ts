import { schema, type UploadRow } from "@open-factory/db";
import type { MessageAttachment } from "@open-factory/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Exec } from "../agents/event-store.ts";

const { uploads } = schema;

export const INVALID_ATTACHMENT =
  "An attached file isn't available any more; remove it and try again.";

/** The line the model reads for one file (U3 §13.5); the path is relative to the agent's cwd. */
export const attachedLine = (storedPath: string) => `[attached: ${storedPath}]`;

/** The body the agent receives: the typed text, a blank line, then one `[attached: …]` line per file. */
export const bodyWithAttachments = (body: string, rows: UploadRow[]) =>
  rows.length ? `${body}\n\n${rows.map((r) => attachedLine(r.storedPath)).join("\n")}` : body;

/** The envelope's UI entry for one upload. */
export const attachmentOf = (r: UploadRow): MessageAttachment => ({
  uploadId: r.id,
  name: r.originalName,
  kind: r.kind,
  ...(r.width !== null ? { width: r.width } : {}),
  ...(r.height !== null ? { height: r.height } : {}),
});

/**
 * The uploads `ids` name, in that order, when every one belongs to this agent and this sender and is unused (and none
 * repeats); otherwise undefined. A pre-check for a clear refusal: `claimUploads` settles a race inside the insert's
 * transaction.
 */
export async function loadAttachments(
  db: Exec,
  ids: string[],
  agentId: string,
  uploaderId: string,
): Promise<UploadRow[] | undefined> {
  if (new Set(ids).size !== ids.length) return undefined;
  const rows = await db.select().from(uploads).where(inArray(uploads.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: UploadRow[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || r.agentId !== agentId || r.uploaderId !== uploaderId || r.messageId !== null)
      return undefined;
    out.push(r);
  }
  return out;
}

/** Sets `message_id` on every upload, only if each is still this agent's, this sender's and unused. */
export async function claimUploads(
  tx: Exec,
  ids: string[],
  messageId: string,
  agentId: string,
  uploaderId: string,
): Promise<boolean> {
  const claimed = await tx
    .update(uploads)
    .set({ messageId })
    .where(
      and(
        inArray(uploads.id, ids),
        eq(uploads.agentId, agentId),
        eq(uploads.uploaderId, uploaderId),
        isNull(uploads.messageId),
      ),
    )
    .returning({ id: uploads.id });
  return claimed.length === ids.length;
}
