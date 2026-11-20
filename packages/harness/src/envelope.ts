import type { FactoryMessage } from "./types.ts";

const attr = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Any spelling of an opening or closing factory-message tag (case, inner spaces). */
const TAG = /<(\s*\/?\s*)factory-message/gi;

/** Only the envelope tag is neutralised in a body; everything else reaches the model unchanged. */
const body = (s: string) => s.replace(TAG, "&lt;$1factory-message");

function one(m: FactoryMessage): string {
  const task = m.taskKey ? ` task="${attr(m.taskKey)}"` : "";
  return (
    `<factory-message from="${attr(m.from)}" kind="${m.kind}" urgent="${m.urgent}" id="${attr(m.id)}"${task}>\n` +
    `${body(m.body)}\n</factory-message>`
  );
}

/** One user turn: the envelopes in order, separated by a blank line (Message concept). */
export function renderEnvelopes(messages: FactoryMessage[]): string {
  return messages.map(one).join("\n\n");
}
