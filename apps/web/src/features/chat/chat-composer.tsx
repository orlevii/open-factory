import { ApiError, type ChatEntry, type SendMessagesResponse } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type ComposerHandle,
  type ComposerNote,
  Composer as ComposerPrimitive,
  type HintMode,
  NETWORK_ERROR,
  SubmitError,
  type SubmitOptions,
  UNCONFIRMED,
} from "@/components/composer/composer";
import { refOfHandle } from "@/features/principals/api";
import { postInterrupt } from "@/features/session/api";
import { commandsQueryOptions, knownCommand } from "@/features/session/commands";
import { SEND_TIMEOUT_MS } from "@/features/session/composer";
import { LINK_CLASS } from "@/features/session/message-block";
import { registerComposerFocus, repinTimeline } from "@/features/session/session-commands";
import { uploadsFor } from "@/features/session/uploads";
import {
  chatDraftKey,
  readDraft,
  readRecipients,
  sessionDraftKey,
  writeDraft,
  writeRecipients,
} from "@/lib/drafts";
import { isCoarsePointer } from "@/lib/send-key";
import { sessionQueryOptions } from "@/lib/session";
import { recipientSource } from "./recipient-source";
import { refusedBecause, sendMessages, slugOf } from "./send";
import { addSending, dropSending, lastSentText, refreshChat } from "./use-chat";

export const FILES_ONE_AGENT = "Files go to one agent at a time";
/** A leading `/token`, the whole text up to its first whitespace. */
const LEADING_COMMAND = /^\s*\/(\S+)/;

/** "Not sent to @a: terminated. Not sent to @b: archived." One line per refused recipient. */
const refusalLines = (rs: SendMessagesResponse["results"]) =>
  rs.map((r) => `Not sent to @${slugOf(r.to)}: ${refusedBecause(r)}.`);

type Props = {
  slug: string;
  /** The chat's agent. */
  agentName: string;
  /** Your user id: the uploads are yours. */
  userId: string | undefined;
  /** The turn that read your message is running: Stop shows, Esc stops it. */
  working: boolean;
  /** The key of that turn (Stop resets when it changes). */
  workingKey: string | undefined;
  turnOpen: boolean;
  compacting: boolean;
  /** The thread is still loading: typing works, sending waits. */
  waiting: boolean;
  docked?: boolean;
  /** A send began (a stable callback): from a `?message=` window the chat goes back to the newest. */
  onSend?: () => void;
};

/** A note held until the text changes, and, for the files one, until the files do. */
type Refusal = { text: string; files?: number };

/**
 * The Chat's composer (I1 §6.6): the shared `Composer` with `@` and attach, a send to one to ten agents
 * (`POST /api/messages`), your message in the thread at once (an entry of the chat's own list, keyed
 * by its `clientMessageId`), Stop while the turn that read your message runs, and the draft with its
 * recipients. Primitive props only, so a thread change never renders it.
 */
export const ChatComposer = memo(function ChatComposer({
  slug,
  agentName,
  userId,
  working,
  workingKey,
  turnOpen,
  compacting,
  waiting,
  docked = false,
  onSend,
}: Props) {
  const qc = useQueryClient();
  const draftKey = chatDraftKey(slug);
  const inner = useRef<ComposerHandle>(null);
  useEffect(() => registerComposerFocus(slug, () => inner.current?.focus()), [slug]);
  const store = uploadsFor(userId, slug);

  // The agents you added (slugs). Persisted beside the text; the ref is what handlers read.
  const [recipients, setRecipientsState] = useState(() =>
    readRecipients(draftKey).filter((s) => s !== slug),
  );
  const recipientsRef = useRef(recipients);
  // One note from the last send or a refused add, shown in the note slot until the next change.
  const [refusal, setRefusal] = useState<Refusal | undefined>();
  const fileCount = useSyncExternalStore(store.subscribe, () => store.summary().count);
  const fileCountRef = useRef(fileCount);
  fileCountRef.current = fileCount;
  const onEdit = useCallback(() => setRefusal(undefined), []);
  const onRecipientsChange = useCallback(
    (next: readonly string[]) => {
      recipientsRef.current = [...next];
      setRecipientsState(recipientsRef.current);
      writeRecipients(draftKey, next);
      setRefusal(undefined);
    },
    [draftKey],
  );
  const source = useMemo(
    () =>
      recipientSource(qc, {
        slug,
        added: () => recipientsRef.current,
        add(added) {
          if (store.summary().count > 0) {
            setRefusal({ text: FILES_ONE_AGENT, files: fileCountRef.current });
            return false;
          }
          onRecipientsChange([...recipientsRef.current, added]);
          return true;
        },
      }),
    [qc, slug, store, onRecipientsChange],
  );
  const completions = useMemo(() => ({ at: source }), [source]);

  const onSubmit = useCallback(
    async (text: string, { urgent, clientMessageId, attachments }: SubmitOptions) => {
      const body = text.trim();
      const added = recipientsRef.current;
      const to = [slug, ...added];
      addSending(qc, slug, {
        kind: "message",
        id: clientMessageId,
        clientMessageId,
        from: { kind: "human", ref: qc.getQueryData(sessionQueryOptions.queryKey)?.user.ref ?? "" },
        body,
        // Refs come from the principals cache; the server's row replaces this entry.
        recipients: to.map((s) => ({ ref: refOfHandle(qc, s) ?? "" })),
        urgent,
        createdAt: new Date().toISOString(),
        state: "pending",
        ...(attachments.length ? { attachments: store.describe(attachments) } : {}),
      } satisfies ChatEntry);
      repinTimeline(slug); // sending follows the conversation again
      onSend?.();
      setRefusal(undefined);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
      try {
        const { results } = await sendMessages({
          to,
          body,
          urgent,
          clientMessageId,
          attachments,
          signal: abort.signal,
        });
        const mine = results.find((r) => slugOf(r.to) === slug);
        const refusedOthers = results.filter(
          (r) => r.status === "refused" && slugOf(r.to) !== slug,
        );
        if (mine?.status === "refused") {
          dropSending(qc, slug, clientMessageId);
          const wentTo = results.filter((r) => r.status !== "refused").map((r) => slugOf(r.to));
          throw new SubmitError(
            [
              mine.reason ?? `${agentName} didn't get this.`,
              ...refusalLines(refusedOthers),
              ...(wentTo.length ? [`Sent to ${wentTo.map((s) => `@${s}`).join(", ")} only.`] : []),
            ].join(" "),
          );
        }
        // The server's row takes the optimistic block's place (same key); nothing waits for the frame.
        void refreshChat(qc, slug, "frame");
        if (refusedOthers.length) setRefusal({ text: refusalLines(refusedOthers).join(" ") });
      } catch (e) {
        if (e instanceof SubmitError) throw e;
        dropSending(qc, slug, clientMessageId);
        if (abort.signal.aborted) throw new SubmitError(UNCONFIRMED, { unconfirmed: true });
        throw new SubmitError(e instanceof ApiError ? e.message : NETWORK_ERROR);
      } finally {
        clearTimeout(timer);
      }
    },
    [qc, slug, agentName, store, onSend],
  );
  const recall = useCallback(() => lastSentText(qc, slug), [qc, slug]);
  const onStop = useCallback(() => postInterrupt(slug), [slug]);

  // Stop resets when another turn starts to be the one that read your message.
  const [epoch, setEpoch] = useState({ key: workingKey, n: 0 });
  if (epoch.key !== workingKey) setEpoch({ key: workingKey, n: epoch.n + 1 });

  // The command list loads beside the chat: the note for a leading `/` reads it, and shows once it is in.
  const commands = useQuery(commandsQueryOptions(slug)).data;
  // A leading `/` is text here: the note says where commands run, and carries the text there.
  const noteFor = useCallback(
    (text: string): ComposerNote | undefined => {
      const m = LEADING_COMMAND.exec(text);
      if (!m?.[1] || !knownCommand(commands, m[1])) return undefined;
      const carry = () => {
        const there = readDraft(sessionDraftKey(slug));
        writeDraft(sessionDraftKey(slug), there.trim() ? `${there}\n${text}` : text);
      };
      return {
        kind: "hint",
        text: (
          <>
            Commands run in the session ·{" "}
            <Link
              to="/agents/$slug/session"
              params={{ slug }}
              className={LINK_CLASS}
              onClick={carry}
            >
              Open session
            </Link>
          </>
        ),
      };
    },
    [slug, commands],
  );
  const note = useMemo<ComposerNote | undefined>(
    () =>
      refusal && (refusal.files === undefined || refusal.files === fileCount)
        ? { kind: "refusal", text: refusal.text }
        : undefined,
    [refusal, fileCount],
  );
  const others = recipients.length;
  // The touch hint points at Stop, so it shows only where Stop does (the turn read your message).
  const hintMode: HintMode = !turnOpen
    ? "none"
    : !isCoarsePointer()
      ? "working"
      : working
        ? "coarse"
        : "none";
  return (
    <ComposerPrimitive
      ref={inner}
      id="composer"
      docked={docked}
      className="shrink-0 border-t border-border px-4 py-3 md:px-6"
      draftKey={draftKey}
      label={`Message to ${agentName}`}
      placeholder={
        others > 0
          ? `Message ${agentName} and ${others} other${others === 1 ? "" : "s"}`
          : `Message ${agentName}`
      }
      turnPlaceholder={`Sends after @${slug}'s current step`}
      onSubmit={onSubmit}
      waiting={waiting}
      turnOpen={turnOpen}
      compacting={compacting}
      stopVisible={working}
      stopEpoch={epoch.n}
      onStop={onStop}
      hintMode={hintMode}
      completions={completions}
      attachments={store}
      attachBlocked={others > 0 ? FILES_ONE_AGENT : undefined}
      recipients={recipients}
      recipientsTo={agentName}
      onRecipientsChange={onRecipientsChange}
      onEdit={onEdit}
      noteFor={noteFor}
      note={note}
      reserveNote
      recall={recall}
    />
  );
});
