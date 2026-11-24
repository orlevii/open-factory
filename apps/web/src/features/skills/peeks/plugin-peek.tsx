import type {
  pluginContentsSchema,
  pluginDetailSchema,
  pluginUsersSchema,
} from "@open-factory/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { z } from "zod";
import { ErrorLine } from "@/components/error-line";
import { MiddleTruncate } from "@/components/middle-truncate";
import { Button } from "@/components/ui/button";
import { SheetBody, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { notify } from "@/components/ui/toaster";
import {
  UntrustedCode,
  UntrustedInlineCode,
  UntrustedProse,
  visibleControls,
} from "@/components/untrusted-text";
import { LatestBadge } from "@/features/config/latest-badge";
import { FORM_MSG } from "@/lib/form-messages";
import {
  addHostMarketplace,
  type PluginFrom,
  pluginFileQueryOptions,
  pluginQueryOptions,
  pluginsQueryOptions,
  readPlugin,
  removeMarketplace,
  selectPluginRow,
} from "@/lib/library";
import { ContentsLine } from "../contents-line";
import { count, parsePluginPin, pluginRowState, versionLabel } from "../format";
import { LINK } from "../helpers";
import { RowState } from "../row-state";
import { arrivalState } from "../use-library-arrival";
import { FileView } from "./file-view";
import { NeedsFromImage } from "./needs-from-image";
import {
  BackButton,
  Clamped,
  failure,
  type Line,
  Outcome,
  Pending,
  PinButton,
  Section,
  SkeletonRows,
} from "./sections";

type Detail = z.infer<typeof pluginDetailSchema>;
type Contents = z.infer<typeof pluginContentsSchema>;
type Users = z.infer<typeof pluginUsersSchema>;

const COLLAPSE_PROVIDES = 20;
const COLLAPSE_FILES = 20;

const CODE_PART_LABEL = {
  lsp: "Language servers",
  statusLine: "Status line",
  monitors: "Monitors",
  bin: "Executables",
  node: "Node dependencies",
} as const;

function HookRow({ h }: { h: Contents["hooks"][number] }) {
  // Below a 28rem container the event and matcher stack above the command (SheetBody is the container).
  return (
    <li className="flex flex-wrap gap-x-3 gap-y-0.5 @max-[28rem]:flex-col">
      <p>
        <UntrustedInlineCode text={h.matcher ? `${h.event} · ${h.matcher}` : h.event} />
      </p>
      <div className="min-w-0 flex-1 basis-60">
        <UntrustedCode text={h.command} clampLines={200} />
      </div>
    </li>
  );
}

function McpRow({ m }: { m: Contents["mcp"][number] }) {
  const lines = [
    ...(m.command ? [[m.command, ...m.args].join(" ")] : []),
    ...(m.url ? [m.url] : []),
    ...(m.headers.length > 0 ? [`headers: ${m.headers.join(", ")}`] : []),
    ...m.env.map((e) => (e.value === null ? e.name : `${e.name}=${e.value}`)),
  ];
  return (
    <li className="space-y-0.5">
      <p className="font-mono text-[0.8125rem]">
        <UntrustedProse text={m.name} />
        <span className="text-muted-foreground"> · {m.kind}</span>
      </p>
      <UntrustedCode text={lines.join("\n")} clampLines={200} />
    </li>
  );
}

/** The parts that run code, first and never collapsed (spec §10.3). */
function RunsCode({ contents }: { contents: Contents }) {
  const { hooks, mcp, dependencies, codeParts, unshown } = contents;
  const none =
    hooks.length + mcp.length + dependencies.length + codeParts.length + unshown.length === 0;
  return (
    <Section title="Runs code">
      {none ? (
        <p className="text-[0.8125rem] text-muted-foreground">Runs no hooks or servers.</p>
      ) : (
        <div className="space-y-3">
          {hooks.length > 0 && (
            <ul className="space-y-2" aria-label="Hooks">
              {hooks.map((h, i) => (
                <HookRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: two hooks can be identical, and the list is static
                  key={`${i}\0${h.event}\0${h.matcher}\0${h.command}`}
                  h={h}
                />
              ))}
            </ul>
          )}
          {mcp.length > 0 && (
            <ul className="space-y-2" aria-label="MCP servers">
              {mcp.map((m, i) => (
                <McpRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: two servers can share a name, and the list is static
                  key={`${i}\0${m.name}`}
                  m={m}
                />
              ))}
            </ul>
          )}
          {dependencies.length > 0 && (
            <div className="text-[0.8125rem]">
              <p className="text-muted-foreground">Dependencies</p>
              <p>
                <UntrustedInlineCode text={dependencies.join(", ")} />
              </p>
            </div>
          )}
          {codeParts.map((p) => (
            <div key={p.kind} className="text-[0.8125rem]">
              <p className="text-muted-foreground">{CODE_PART_LABEL[p.kind]}</p>
              <UntrustedCode text={p.items.join("\n")} clampLines={200} />
            </div>
          ))}
          {unshown.length > 0 && (
            <p className="text-[0.8125rem]">
              This plugin has parts Open Factory can't show:{" "}
              <UntrustedProse text={unshown.join(", ")} />
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

function ProvidesKind({ title, names }: { title: string; names: string[] }) {
  const [all, setAll] = useState(false);
  if (names.length === 0) return null;
  const shown = all ? names : names.slice(0, COLLAPSE_PROVIDES);
  return (
    <div className="text-[0.8125rem]">
      <p className="text-muted-foreground">{title}</p>
      <p>
        <UntrustedInlineCode text={shown.join(", ")} />
      </p>
      {!all && names.length > COLLAPSE_PROVIDES && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          Show all {names.length}
        </button>
      )}
    </div>
  );
}

function Provides({ provides }: { provides: Contents["provides"] }) {
  const { skills, commands, agents, outputStyles } = provides;
  if (skills.length + commands.length + agents.length + outputStyles.length === 0) return null;
  return (
    <Section title="Provides">
      <div className="space-y-2">
        <ProvidesKind title="Skills" names={skills} />
        <ProvidesKind title="Commands" names={commands} />
        <ProvidesKind title="Agents" names={agents} />
        <ProvidesKind title="Output styles" names={outputStyles} />
      </div>
    </Section>
  );
}

function Provenance({
  detail,
  libraryCommit,
}: {
  detail: Detail;
  /** The commit Skills read, for the "Local folder, live" test: a registered plugin with none is live. */
  libraryCommit: string | null | undefined;
}) {
  const commit = detail.commit ?? libraryCommit ?? null;
  return (
    <Section title="Provenance">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[0.8125rem]">
        <dt className="text-muted-foreground">Marketplace</dt>
        <dd className="font-mono">
          <UntrustedProse text={detail.marketplace} />
        </dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd>
          <UntrustedInlineCode text={detail.source.detail} />
        </dd>
        {detail.from === "library" && (
          <>
            <dt className="text-muted-foreground">Commit</dt>
            <dd>
              {commit ? (
                <>
                  <PinButton sha={commit} />
                  <span className="mt-1 block font-mono text-xs break-all select-text">
                    {commit}
                  </span>
                </>
              ) : (
                "Local folder, live"
              )}
            </dd>
          </>
        )}
      </dl>
      {!detail.pinnable && detail.state !== "refused" && (
        <p className="mt-2 text-[0.8125rem]">Can't be pinned: it follows its own source.</p>
      )}
      {detail.hostVersion && (
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          Also on this host ({detail.hostVersion})
        </p>
      )}
    </Section>
  );
}

function PinText({ pin }: { pin: string }) {
  const p = parsePluginPin(pin);
  switch (p.kind) {
    case "commit":
      return <span className="text-muted-foreground">pinned {p.sha.slice(0, 7)}</span>;
    case "tag":
      return <span className="text-muted-foreground">pinned tag {p.name}</span>;
    case "latest":
      return <LatestBadge />;
    case "live":
      return <span className="text-muted-foreground">live</span>;
  }
}

/** Each template with its pin, and the agents that add the plugin; plain text when the peek is read-only (no links). */
function UsedBy({ users, readOnly }: { users: Users; readOnly: boolean }) {
  if (users.templates.length + users.overlays.length === 0) return null;
  return (
    <Section title="Used by">
      <ul className="space-y-1">
        {users.templates.map((t) => (
          <li key={t.name} className="flex flex-wrap items-center gap-x-2 text-[0.8125rem]">
            {readOnly ? (
              <span>{t.name}</span>
            ) : (
              <Link to="/templates/$name" params={{ name: t.name }} className={LINK}>
                {t.name}
              </Link>
            )}
            <span aria-hidden="true">·</span>
            <PinText pin={t.pin} />
            <span className="text-muted-foreground">· {count(t.agents, "agent")}</span>
          </li>
        ))}
        {users.overlays.map((o) => (
          <li key={o.agent} className="flex flex-wrap items-center gap-x-2 text-[0.8125rem]">
            {readOnly ? (
              <span>@{o.agent}</span>
            ) : (
              <Link to="/agents/$slug" params={{ slug: o.agent }} className={LINK}>
                @{o.agent}
              </Link>
            )}
            <span className="text-muted-foreground">adds it · template {o.template}</span>
            <PinText pin={o.pin} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Files({
  files,
  pluginKey,
  from,
  commit,
}: {
  files: string[];
  pluginKey: string;
  from: PluginFrom;
  commit: string | undefined;
}) {
  if (files.length === 0) return null;
  return (
    <Section title="Files">
      <ul>
        <Clamped
          items={files}
          limit={COLLAPSE_FILES}
          render={(path) => (
            <FileView
              key={path}
              path={path}
              executable={false}
              options={pluginFileQueryOptions(pluginKey, path, from, commit)}
            />
          )}
        />
      </ul>
    </Section>
  );
}

/** Static rows at the real heights of what the summary says is coming, so the sections don't jump (spec §10.3). */
function ContentsSkeleton({ rows }: { rows: number }) {
  return (
    <div role="status" className="space-y-2">
      <p className="text-[0.8125rem] text-muted-foreground">Loading contents…</p>
      <SkeletonRows n={rows} />
    </div>
  );
}

/**
 * The Plugin peek (spec §10.3). It renders from the cached list row at once (module-level `select`, R-L2) and refines
 * from the detail query, whose key carries the commit and where it is read from. `readOnly` is the Configuration form's
 * view at a template's pin: no actions and no Used by links, and it ends with "Open in Skills". Read contents and Add
 * its marketplace are mutations from handlers; this body is keyed by the peek's key, so their state is dropped when the
 * peek retargets (R-Q1).
 */
export function PluginPeekBody({
  pluginKey,
  from = "library",
  commit,
  readOnly = false,
  back,
  onBack,
}: {
  pluginKey: string;
  from?: PluginFrom;
  /** The commit to read: a template's pin. Absent means the Library's. */
  commit?: string;
  readOnly?: boolean;
  back: string | null;
  onBack(): void;
}) {
  const qc = useQueryClient();
  const { data: cached } = useQuery({
    ...pluginsQueryOptions,
    select: selectPluginRow(pluginKey, from),
  });
  const q = useQuery(pluginQueryOptions(pluginKey, from, commit));
  const d = q.data;
  const row = cached?.entry;
  const libraryCommit = cached?.from === "library" ? cached.commit : undefined;
  const refresh = () => qc.invalidateQueries({ queryKey: ["library"] });
  const [readLine, setReadLine] = useState<Line>();
  const [addLine, setAddLine] = useState<Line>();
  const read = useMutation({ mutationFn: () => readPlugin(pluginKey, commit), onSuccess: refresh });
  const addMkt = useMutation({
    mutationFn: () => addHostMarketplace(pluginKey),
    onSuccess: (m) => {
      void refresh();
      notify({
        text: `Added ${m.name}${m.commit ? ` at ${m.commit.slice(0, 7)}` : ""}.`,
        undo: async () => {
          await removeMarketplace(m.name);
          await refresh();
        },
      });
    },
  });

  const summary = d?.contents?.summary ?? row?.contentsSummary ?? null;
  const version = d?.version ?? row?.version ?? null;
  const description = d?.description ?? (row && "description" in row ? row.description : undefined);
  const state = d ? pluginRowState(d) : row && "state" in row ? pluginRowState(row) : undefined;
  const atPin = commit !== undefined && commit !== libraryCommit;
  const loadingRows = Math.min(
    summary ? summary.hooks + summary.mcp + summary.codeParts + summary.dependencies : 3,
    6,
  );
  const host = from === "host";
  const hostRow = host && row && "marketplace" in row ? row : undefined;
  const refused = hostRow?.addRefusedReason;

  const onRead = () => {
    setReadLine(undefined);
    read.mutate(undefined, {
      onError: (e) => setReadLine({ tone: "error", node: failure(e, FORM_MSG.unreachable) }),
    });
  };
  const onAdd = () => {
    setAddLine(undefined);
    addMkt.mutate(undefined, {
      onError: (e) => setAddLine({ tone: "error", node: failure(e, FORM_MSG.unreachable) }),
    });
  };

  return (
    <>
      <SheetHeader className="items-center">
        {back !== null && <BackButton onBack={onBack} />}
        <SheetTitle className="font-mono text-sm font-normal">
          <MiddleTruncate text={visibleControls(pluginKey)} />
        </SheetTitle>
      </SheetHeader>
      <SheetBody className="space-y-4">
        <div className="space-y-1.5 text-[0.8125rem]">
          {(version || atPin) && (
            <p className="flex flex-wrap gap-x-3">
              {version && <span className="font-mono">{versionLabel(version)}</span>}
              {atPin && commit && (
                <span className="text-muted-foreground">
                  At <span className="font-mono">{commit.slice(0, 7)}</span>
                </span>
              )}
            </p>
          )}
          {description && (
            <p className="text-sm">
              <UntrustedProse text={description} />
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-4">
            <ContentsLine summary={summary} all unreadable="Contents not read yet" />
          </div>
          {state && (
            <p className="flex items-center gap-2">
              <RowState state={state} />
              {d?.refusedReason && <UntrustedProse text={d.refusedReason} />}
            </p>
          )}
        </div>
        {d ? (
          d.contents ? (
            <>
              <RunsCode contents={d.contents} />
              <NeedsFromImage needs={d.contents.needs} />
              <Provides provides={d.contents.provides} />
              <Provenance detail={d} libraryCommit={libraryCommit} />
              <UsedBy users={d.usedBy} readOnly={readOnly} />
              <Files files={d.contents.files} pluginKey={pluginKey} from={from} commit={commit} />
            </>
          ) : (
            <>
              <Section title="Contents">
                <p className="text-[0.8125rem] text-muted-foreground">
                  {visibleControls(d.contentsNote ?? "Contents not read yet")}
                </p>
                {d.canRead && !readOnly && (
                  <div className="mt-2">
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-disabled={read.isPending}
                      onClick={() => !read.isPending && onRead()}
                    >
                      {read.isPending ? (
                        <Pending label="Reading…" since={read.submittedAt} />
                      ) : (
                        "Read contents"
                      )}
                    </Button>
                  </div>
                )}
                <Outcome line={readLine} />
              </Section>
              <Provenance detail={d} libraryCommit={libraryCommit} />
              <UsedBy users={d.usedBy} readOnly={readOnly} />
            </>
          )
        ) : q.isError ? (
          <ErrorLine text="Couldn't load the plugin." onRetry={() => void q.refetch()} />
        ) : (
          <ContentsSkeleton rows={loadingRows} />
        )}
      </SheetBody>
      {readOnly ? (
        <SheetFooter>
          <Button asChild variant="ghost">
            <Link to="/skills/plugins" state={arrivalState({ kind: "plugin", id: pluginKey })}>
              Open in Skills
            </Link>
          </Button>
        </SheetFooter>
      ) : host ? (
        <SheetFooter className="flex-col items-stretch gap-2">
          <p className="text-[0.8125rem] text-muted-foreground">
            {refused !== undefined
              ? visibleControls(refused)
              : `Registers ${visibleControls(hostRow?.marketplace ?? "its marketplace")} from this host's record. Nothing is installed.`}
          </p>
          <Outcome line={addLine} />
          <Button
            aria-disabled={addMkt.isPending || refused !== undefined}
            onClick={() => !addMkt.isPending && refused === undefined && onAdd()}
            className="self-end"
          >
            {addMkt.isPending ? (
              <Pending label="Adding…" since={addMkt.submittedAt} />
            ) : (
              "Add its marketplace"
            )}
          </Button>
        </SheetFooter>
      ) : null}
    </>
  );
}
