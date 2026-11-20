import { ApiError, type InviteItem, type UserAdminItem } from "@open-factory/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleSlash, Loader2, Plus } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorLine } from "@/components/error-line";
import { InlineOutcome } from "@/components/inline-outcome";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDay } from "@/features/session/format";
import {
  createInvite,
  disableUser,
  enableUser,
  invitesQueryOptions,
  restoreInvite,
  revokeInvite,
  usersQueryOptions,
} from "@/features/settings/api";
import { InviteReveal } from "@/features/settings/invite-reveal";
import {
  focusOutcome,
  MoreButton,
  monoClass,
  RowLine,
  SettingsList,
  SettingsSection,
  smallClass,
  useFocusLater,
} from "@/features/settings/shared";
import { sessionQueryOptions } from "@/lib/session";

type Outcome = {
  tone: "success" | "error" | "pending";
  content: ReactNode;
  focusKey?: number;
  undo?: () => void;
};

/** The 409s from disable, as the spec words them (S10 §12.10). */
function disableError(err: unknown, handle: string): string | undefined {
  if (!(err instanceof ApiError)) return undefined;
  if (err.code === "cannot_disable_self") return "You can't disable yourself.";
  if (err.code === "last_enabled_user") {
    return `@${handle} is the last enabled user. Enable someone else first.`;
  }
  return undefined;
}

/** Why an Undo of a revoke failed (409 from restore). */
function restoreError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "invite_expired") return "Couldn't restore the invite: it has expired.";
    if (err.code === "invite_used") return "Couldn't restore the invite: it was already used.";
    if (err.code === "invite_creator_disabled") {
      return "Couldn't restore the invite: its creator is disabled.";
    }
  }
  return "Couldn't restore the invite. Try again.";
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
/** "in 6 days", "in 5 hours", "in 12 minutes": an invite lives 7 days, so days are the largest unit. */
export function expiresIn(iso: string, now = Date.now()): string {
  const s = Math.max(0, (new Date(iso).getTime() - now) / 1000);
  if (s >= 86_400) return rtf.format(Math.round(s / 86_400), "day");
  if (s >= 3_600) return rtf.format(Math.round(s / 3_600), "hour");
  return rtf.format(Math.max(1, Math.round(s / 60)), "minute");
}

/** Why Disable is unavailable, shown inside the menu item; undefined when it is available. */
function disableBlocker(u: UserAdminItem, meId: string | undefined, users: UserAdminItem[]) {
  if (u.id === meId) return "that's you";
  if (!u.disabledAt && users.filter((x) => !x.disabledAt).length <= 1) return "last enabled user";
  return undefined;
}

/** "Their 2 pending invites are revoked." / "Their pending invite is revoked." / dropped at 0. */
function disableBody(pending: number): string {
  const invites =
    pending === 0
      ? ""
      : pending === 1
        ? " Their pending invite is revoked."
        : ` Their ${pending} pending invites are revoked.`;
  return `They're signed out everywhere and can't sign in.${invites} You can enable them again later; revoked invites stay revoked.`;
}

function InviteRow({
  invite,
  creator,
  onRevoke,
}: {
  invite: InviteItem;
  creator: string;
  onRevoke(): void;
}) {
  return (
    <li data-name={invite.id} className="px-2 py-1.5">
      <RowLine
        actions={
          <Button
            id={`invite-revoke-${invite.id}`}
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRevoke}
          >
            Revoke
          </Button>
        }
      >
        <span className={`${smallClass} text-muted-foreground tabular-nums`}>
          Created by @{creator} · expires {expiresIn(invite.expiresAt)}
        </span>
      </RowLine>
    </li>
  );
}

export function UsersSection() {
  const qc = useQueryClient();
  const usersQuery = useQuery(usersQueryOptions);
  const invitesQuery = useQuery(invitesQueryOptions);
  const meId = useQuery(sessionQueryOptions).data?.user.id;
  const focusLater = useFocusLater();
  const [rowOutcome, setRowOutcome] = useState<Record<string, Outcome>>({});
  const [inviteOutcome, setInviteOutcome] = useState<Outcome>();
  const [createOutcome, setCreateOutcome] = useState<Outcome>();
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<string>();
  // The dialog keeps its user while it animates out; `confirmOpen` drives it.
  const [confirming, setConfirming] = useState<UserAdminItem>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Set when a menu item opens the dialog: the menu then leaves focus to it instead of ⋯.
  const menuHandsOff = useRef(false);
  // What the closing dialog should focus: the row's outcome after a refused disable.
  const afterDialog = useRef<string | undefined>(undefined);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: usersQueryOptions.queryKey });
    void qc.invalidateQueries({ queryKey: invitesQueryOptions.queryKey });
  };
  const setRow = (id: string, o: Outcome | undefined) =>
    setRowOutcome((s) => {
      const next = { ...s };
      if (o) next[id] = o;
      else delete next[id];
      return next;
    });
  const patchUser = (id: string, disabledAt: string | null) =>
    qc.setQueryData(usersQueryOptions.queryKey, (old) =>
      old?.map((u) => (u.id === id ? { ...u, disabledAt } : u)),
    );

  const users = usersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];
  const handleOf = (id: string) => users.find((u) => u.id === id)?.handle ?? "unknown";

  async function disable(u: UserAdminItem) {
    setRow(u.id, undefined);
    try {
      await disableUser(u.id);
      patchUser(u.id, new Date().toISOString());
      qc.setQueryData(invitesQueryOptions.queryKey, (old) =>
        old?.filter((i) => i.createdBy !== u.id),
      );
      refresh();
    } catch (err) {
      const sentence = disableError(err, u.handle);
      if (!sentence) throw err;
      setRow(u.id, { tone: "error", content: sentence });
      afterDialog.current = `user-outcome-${u.id}`;
      refresh();
    }
  }

  async function enable(u: UserAdminItem) {
    setRow(u.id, undefined);
    try {
      await enableUser(u.id);
      patchUser(u.id, null);
      setRow(u.id, {
        tone: "success",
        content: `Enabled @${u.handle}. They can sign in again.`,
        focusKey: Date.now(),
      });
      refresh();
    } catch (err) {
      setRow(u.id, {
        tone: "error",
        content: err instanceof ApiError ? err.message : `Couldn't enable @${u.handle}. Try again.`,
        focusKey: Date.now(),
      });
    }
  }

  async function revoke(invite: InviteItem) {
    const creator = handleOf(invite.createdBy);
    setInviteOutcome(undefined);
    try {
      await revokeInvite(invite.id);
    } catch (err) {
      setInviteOutcome({
        tone: "error",
        content: err instanceof ApiError ? err.message : "Couldn't revoke the invite. Try again.",
        focusKey: Date.now(),
      });
      return;
    }
    qc.setQueryData(invitesQueryOptions.queryKey, (old) => old?.filter((i) => i.id !== invite.id));
    setInviteOutcome({
      tone: "success",
      content: `Revoked the invite from @${creator}.`,
      undo: () => void undo(invite),
      focusKey: Date.now(),
    });
    refresh();
  }

  async function undo(invite: InviteItem) {
    // The line stays while the request runs; dropping Undo stops a second restore.
    setInviteOutcome((o) => o && { ...o, undo: undefined, focusKey: undefined });
    try {
      await restoreInvite(invite.id);
      setInviteOutcome(undefined);
      qc.setQueryData(invitesQueryOptions.queryKey, (old) =>
        old && !old.some((i) => i.id === invite.id)
          ? [...old, invite].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          : old,
      );
      focusLater(`invite-revoke-${invite.id}`);
      refresh();
    } catch (err) {
      setInviteOutcome({ tone: "error", content: restoreError(err), focusKey: Date.now() });
    }
  }

  async function create() {
    if (creating) return;
    setCreating(true);
    setCreateOutcome(undefined);
    try {
      const r = await createInvite();
      setLink(r.link);
      qc.setQueryData(invitesQueryOptions.queryKey, (old) =>
        old && !old.some((i) => i.id === r.invite.id) ? [...old, r.invite] : old,
      );
      refresh();
    } catch {
      setCreateOutcome({ tone: "error", content: "Couldn't create an invite. Try again." });
    } finally {
      setCreating(false);
    }
  }

  const failed =
    (!usersQuery.data && usersQuery.isError) || (!invitesQuery.data && invitesQuery.isError);
  const pendingFor = (id: string) => invites.filter((i) => i.createdBy === id).length;

  return (
    <SettingsSection id="users" title="Users">
      {failed && (
        <ErrorLine
          text="Couldn't load users."
          onRetry={() => {
            void usersQuery.refetch();
            void invitesQuery.refetch();
          }}
        />
      )}
      {usersQuery.data && (
        <SettingsList>
          {users.map((u) => {
            const blocker = disableBlocker(u, meId, users);
            const o = rowOutcome[u.id];
            return (
              <li
                key={u.id}
                data-name={u.handle}
                className="grid grid-cols-[minmax(0,1fr)] gap-1 px-2 py-1.5"
              >
                <RowLine
                  actions={
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <MoreButton id={`user-menu-${u.id}`} label={`Actions for @${u.handle}`} />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        onCloseAutoFocus={(e) => {
                          if (!menuHandsOff.current) return;
                          menuHandsOff.current = false;
                          e.preventDefault();
                        }}
                      >
                        {u.disabledAt ? (
                          <DropdownMenuItem onSelect={() => void enable(u)}>
                            Enable
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            disabled={Boolean(blocker)}
                            onSelect={() => {
                              menuHandsOff.current = true; // the dialog places focus
                              afterDialog.current = undefined;
                              setRow(u.id, undefined);
                              setConfirming(u);
                              setConfirmOpen(true);
                            }}
                          >
                            {blocker ? `Disable (${blocker})` : "Disable…"}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  }
                >
                  <span className="min-w-0 text-[0.8125rem] md:w-36 md:shrink-0">
                    {u.name}
                    {u.id === meId && <span className="text-muted-foreground"> (you)</span>}
                  </span>
                  <span className={`${monoClass} min-w-0 break-all`}>@{u.handle}</span>
                  <span className={`${smallClass} min-w-0 break-all text-muted-foreground`}>
                    {u.email}
                  </span>
                  <span className={`${smallClass} text-muted-foreground tabular-nums`}>
                    Joined {formatDay(new Date(u.createdAt), new Date())}
                  </span>
                  {u.disabledAt && (
                    <span className={`flex items-center gap-1.5 ${smallClass}`}>
                      <CircleSlash
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      Disabled
                    </span>
                  )}
                </RowLine>
                <div id={`user-outcome-${u.id}`}>
                  <InlineOutcome tone={o?.tone} focusKey={o?.focusKey}>
                    {o?.content}
                  </InlineOutcome>
                </div>
              </li>
            );
          })}
        </SettingsList>
      )}
      {invites.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-[0.8125rem] font-medium">Pending invites</h3>
          <SettingsList>
            {invites.map((i) => (
              <InviteRow
                key={i.id}
                invite={i}
                creator={handleOf(i.createdBy)}
                onRevoke={() => void revoke(i)}
              />
            ))}
          </SettingsList>
        </div>
      )}
      {/* Empty, it takes no space; it stays mounted so its text is announced. */}
      <div id="invites-outcome" className="[&:not(:has([tabindex]))]:-mt-3">
        <InlineOutcome
          tone={inviteOutcome?.tone}
          undo={inviteOutcome?.undo}
          focusKey={inviteOutcome?.focusKey}
        >
          {inviteOutcome?.content}
        </InlineOutcome>
      </div>
      <div>
        <Button
          id="invites-create"
          type="button"
          variant="ghost"
          aria-disabled={creating || undefined}
          onClick={() => void create()}
        >
          {creating ? (
            <Loader2
              aria-hidden="true"
              data-icon="inline-start"
              className="motion-safe:animate-spin"
            />
          ) : (
            <Plus aria-hidden="true" data-icon="inline-start" />
          )}
          Create invite link
        </Button>
      </div>
      <div className="[&:not(:has([tabindex]))]:-mt-3">
        <InlineOutcome tone={createOutcome?.tone}>{createOutcome?.content}</InlineOutcome>
      </div>
      {link && (
        <InviteReveal
          key={link}
          link={link}
          onDone={() => {
            setLink(undefined);
            focusLater("invites-create");
          }}
        />
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Disable @${confirming?.handle ?? ""}?`}
        body={disableBody(confirming ? pendingFor(confirming.id) : 0)}
        confirmLabel={`Disable @${confirming?.handle ?? ""}`}
        onConfirm={() => (confirming ? disable(confirming) : undefined)}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = afterDialog.current;
          if (target) focusOutcome(target);
          else if (confirming) document.getElementById(`user-menu-${confirming.id}`)?.focus();
        }}
      />
    </SettingsSection>
  );
}
