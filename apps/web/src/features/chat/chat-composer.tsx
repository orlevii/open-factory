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
import { useHandle } from "@/features/agents/use-agent-index";
import { useMentionSource } from "@/features/mentions/mention-source";
import { postInterrupt } from "@/features/session/api";
import { commandsQueryOptions, knownCommand } from "@/features/session/commands";
import { SEND_TIMEOUT_MS } from "@/features/session/composer";
import { LINK_CLASS } from "@/features/session/message-block";
import { registerComposerFocus, repinTimeline } from "@/features/session/session-commands";
import { uploadsFor } from "@/features/session/uploads";
import {
  chatDraftKey,
  MAX_RECIPIENTS,
  readDraft,
  readRecipients,
  sessionDraftKey,
  writeDraft,
  writeRecipients,
} from "@/lib/drafts";
import { isCoarsePointer } from "@/lib/send-key";
import { AddRecipient, FULL_NOTE } from "./add-recipient";
import { handleOfResult, isResultFor, refusedBecause, sendMessages } from "./send";
import { addSending, dropSending, lastSentText, refreshChat } from "./use-chat";

const TAG_NOTE = "A tag doesn't send · Esc keeps it as text";
export const FILES_ONE_AGENT = "Files go to one agent at a time";
/** A leading `/token`, the whole text up to its first whitespace. */
const LEADING_COMMAND = /^\s*\/(\S+)/;

/** "Not sent to @a: terminated. Not sent to @b: archived." One line per refused recipient. */
const refusalLines = (rs: SendMessagesResponse["results"]) =>
  rs.map((r) => `Not sent to @${handleOfResult(r.to)}: ${refusedBecause(r)}.`);

type Props = {
  agentRef: string;
  /** The chat's agent. */
  agentName: string;
  /** Your user id: the uploads are yours. */
  userId: string | undefined;
  /** Your ref, from `/api/me`: the sender of your optimistic message. Sending waits until it is known. */
  userRef: string | undefined;
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
  agentRef,
  agentName,
  userId,
  userRef,
  working,
  workingKey,
  turnOpen,
  compacting,
  waiting,
  docked = false,
  onSend,
}: Props) {
  const qc = useQueryClient();
  const handle = useHandle(agentRef);
  const mentionSource = useMentionSource({ note: TAG_NOTE });
  const draftKey = chatDraftKey(agentRef);
  const inner = useRef<ComposerHandle>(null);
  useEffect(() => registerComposerFocus(agentRef, () => inner.current?.focus()), [agentRef]);
  const store = uploadsFor(userId, agentRef);

  // The agents you added (refs). Persisted beside the text; the ref is what handlers read.
  const [recipients, setRecipientsState] = useState(() =>
    readRecipients(draftKey).filter((s) => s !== agentRef),
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
  const completions = useMemo(() => ({ at: mentionSource }), [mentionSource]);
  // Adding is held at ten agents (the chat's own included, as the server counts) and while files are
  // attached; the button stays focusable and pressing it says why in the note slot.
  const held =
    recipients.length + 1 >= MAX_RECIPIENTS
      ? FULL_NOTE
      : fileCount > 0
        ? FILES_ONE_AGENT
        : undefined;
  const onAdd = useCallback(
    (ref: string) => onRecipientsChange([...recipientsRef.current, ref]),
    [onRecipientsChange],
  );
  const onHeld = useCallback(
    (reason: string) =>
      setRefusal(
        reason === FILES_ONE_AGENT
          ? { text: reason, files: fileCountRef.current }
          : { text: reason },
      ),
    [],
  );
  const addRecipient = useMemo(
    () => (
      <AddRecipient
        agentRef={agentRef}
        recipients={recipients}
        held={held}
        onAdd={onAdd}
        onHeld={onHeld}
      />
    ),
    [agentRef, recipients, held, onAdd, onHeld],
  );
  const addRecipientCompact = useMemo(
    () => (
      <AddRecipient
        compact
        agentRef={agentRef}
        recipients={recipients}
        held={held}
        onAdd={onAdd}
        onHeld={onHeld}
      />
    ),
    [agentRef, recipients, held, onAdd, onHeld],
  );

  const onSubmit = useCallback(
    async (text: string, { urgent, clientMessageId, attachments }: SubmitOptions) => {
      const body = text.trim();
      // Sending waits for the session, so this is known; a blank ref is never written.
      if (userRef === undefined) throw new SubmitError(NETWORK_ERROR);
      const added = recipientsRef.current;
      const to = [agentRef, ...added];
      addSending(qc, agentRef, {
        kind: "message",
        id: clientMessageId,
        clientMessageId,
        from: { kind: "human", ref: userRef },
        body,
        // The server's row replaces this entry.
        recipients: to.map((ref) => ({ ref })),
        urgent,
        createdAt: new Date().toISOString(),
        state: "pending",
        ...(attachments.length ? { attachments: store.describe(attachments) } : {}),
      } satisfies ChatEntry);
      repinTimeline(agentRef); // sending follows the conversation again
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
        const mine = results.find((r) => isResultFor(r.to, agentRef));
        const refusedOthers = results.filter(
          (r) => r.status === "refused" && !isResultFor(r.to, agentRef),
        );
        if (mine?.status === "refused") {
          dropSending(qc, agentRef, clientMessageId);
          const wentTo = results
            .filter((r) => r.status !== "refused")
            .map((r) => handleOfResult(r.to));
          throw new SubmitError(
            [
              mine.reason ?? `${agentName} didn't get this.`,
              ...refusalLines(refusedOthers),
              ...(wentTo.length ? [`Sent to ${wentTo.map((s) => `@${s}`).join(", ")} only.`] : []),
            ].join(" "),
          );
        }
        // The server's row takes the optimistic block's place (same key); nothing waits for the frame.
        void refreshChat(qc, agentRef, "frame");
        if (refusedOthers.length) setRefusal({ text: refusalLines(refusedOthers).join(" ") });
      } catch (e) {
        if (e instanceof SubmitError) throw e;
        dropSending(qc, agentRef, clientMessageId);
        if (abort.signal.aborted) throw new SubmitError(UNCONFIRMED, { unconfirmed: true });
        throw new SubmitError(e instanceof ApiError ? e.message : NETWORK_ERROR);
      } finally {
        clearTimeout(timer);
      }
    },
    [qc, agentRef, agentName, userRef, store, onSend],
  );
  const recall = useCallback(() => lastSentText(qc, agentRef), [qc, agentRef]);
  const onStop = useCallback(() => postInterrupt(agentRef), [agentRef]);

  // Stop resets when another turn starts to be the one that read your message.
  const [epoch, setEpoch] = useState({ key: workingKey, n: 0 });
  if (epoch.key !== workingKey) setEpoch({ key: workingKey, n: epoch.n + 1 });

  // The command list loads beside the chat: the note for a leading `/` reads it, and shows once it is in.
  const commands = useQuery(commandsQueryOptions(agentRef)).data;
  // A leading `/` is text here: the note says where commands run, and carries the text there.
  const noteFor = useCallback(
    (text: string): ComposerNote | undefined => {
      const m = LEADING_COMMAND.exec(text);
      if (!m?.[1] || !knownCommand(commands, m[1])) return undefined;
      const carry = () => {
        const there = readDraft(sessionDraftKey(agentRef));
        writeDraft(sessionDraftKey(agentRef), there.trim() ? `${there}\n${text}` : text);
      };
      return {
        kind: "hint",
        text: (
          <>
            Commands run in the session ·{" "}
            <Link
              to="/agents/$ref/session"
              params={{ ref: agentRef }}
              className={LINK_CLASS}
              onClick={carry}
            >
              Open session
            </Link>
          </>
        ),
      };
    },
    [agentRef, commands],
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
      turnPlaceholder={`Sends after @${handle}'s current step`}
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
      toolbarStart={addRecipient}
      recipientsAdd={addRecipientCompact}
      onEdit={onEdit}
      noteFor={noteFor}
      note={note}
      reserveNote
      recall={recall}
    />
  );
});
