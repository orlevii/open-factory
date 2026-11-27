import type { ChatEntry } from "@open-factory/shared";
import { type Ref, useCallback } from "react";
import { formatTime } from "@/features/session/format";
import { RowMenu, type RowMenuHandle, type RowMenuItem } from "@/features/session/row-menu";

export type MessageEntry = Extract<ChatEntry, { kind: "message" }>;

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** The chat row's menu (I1 §6.4): Copy text, Copy link, View in session (a delivered message is in
 *  the session), Recipients when the message went to others too, and the time on touch. */
export function chatMenuItems(
  entry: MessageEntry,
  agentRef: string,
  others: readonly string[],
  recipientsText: string,
): RowMenuItem[] {
  const items: RowMenuItem[] = [
    { kind: "copy", label: "Copy text", text: entry.body },
    {
      kind: "copy",
      label: "Copy link",
      text: `${location.origin}/agents/${encodeURIComponent(agentRef)}/chat?message=${encodeURIComponent(entry.id)}`,
    },
  ];
  if (entry.state === "delivered")
    items.push({ kind: "session", label: "View in session", to: agentRef, messageId: entry.id });
  if (others.length > 0)
    items.push({ kind: "recipients", label: "Recipients", text: recipientsText });
  items.push({ kind: "time", label: `Sent ${clock(entry.createdAt)}` });
  return items;
}

/** The one ⋯ of a chat row, built from the shared row menu. The list is built when the menu first opens. */
export function ChatRowMenu({
  entry,
  agentRef,
  others,
  recipientsText,
  sender,
  tabbable,
  menuRef,
}: {
  entry: MessageEntry;
  agentRef: string;
  /** The refs of everyone else the message went to. */
  others: readonly string[];
  /** Every recipient's handle, for Copy of the Recipients item. */
  recipientsText: string;
  /** The sender's current handle. */
  sender: string;
  tabbable: boolean;
  menuRef: Ref<RowMenuHandle>;
}) {
  const items = useCallback(
    () => chatMenuItems(entry, agentRef, others, recipientsText),
    [entry, agentRef, others, recipientsText],
  );
  const title = useCallback(
    () => `Message from @${sender} · ${formatTime(entry.createdAt)}`,
    [sender, entry.createdAt],
  );
  return <RowMenu ref={menuRef} items={items} title={title} focusable={tabbable} />;
}
