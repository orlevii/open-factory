import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ErrorLine } from "@/components/error-line";
import { MiddleTruncate } from "@/components/middle-truncate";
import { SheetBody, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { UntrustedCode, UntrustedProse, visibleControls } from "@/components/untrusted-text";
import { FORM_MSG } from "@/lib/form-messages";
import {
  libraryQueryOptions,
  type SkillRowView,
  selectSkillRow,
  skillFileQueryOptions,
  skillQueryOptions,
} from "@/lib/library";
import { count, pinLabel, sourceLabel } from "../format";
import { LINK } from "../helpers";
import { RowState } from "../row-state";
import { sourceKey } from "../use-peek";
import { FileView } from "./file-view";
import { BackButton, Clamped, Section, SkeletonRows } from "./sections";

const COLLAPSE_FILES = 20;
const COLLAPSE_USERS = 8;

type Hook = { event: string; matcher: string; command: string };

/** Frontmatter hooks, each with its event, matcher and full command (spec §10.3 "Runs code"). */
function RunsCode({ hooks }: { hooks: Hook[] }) {
  return (
    <Section title="Runs code">
      <ul className="space-y-2">
        {hooks.map((h) => (
          <li key={`${h.event}\0${h.matcher}\0${h.command}`} className="space-y-0.5">
            <p className="font-mono text-[0.8125rem]">
              <UntrustedProse text={h.event} />
            </p>
            {h.matcher && <UntrustedCode text={h.matcher} clampLines={200} />}
            <UntrustedCode text={h.command} clampLines={200} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

type UsedBy = { name: string; agents: number }[];

const renderUser = (u: UsedBy[number]) => (
  <li key={u.name} className="text-[0.8125rem]">
    <Link to="/templates/$name" params={{ name: u.name }} className={LINK}>
      {u.name}
    </Link>
    {" · "}
    <span className="text-muted-foreground">{count(u.agents, "agent")}</span>
  </li>
);

function UsedBySection({ users }: { users: UsedBy }) {
  if (users.length === 0) return null;
  return (
    <Section title="Used by">
      <ul>
        <Clamped items={users} limit={COLLAPSE_USERS} render={renderUser} />
      </ul>
    </Section>
  );
}

type File = { path: string; executable: boolean };

function FilesSection({
  group,
  name,
  files,
  pin,
  skillMd,
  skillMdCut,
}: {
  group: string;
  name: string;
  files: File[];
  pin: string | null;
  skillMd: string;
  skillMdCut: boolean;
}) {
  if (files.length === 0) return null;
  return (
    <Section title="Files">
      <ul>
        <Clamped
          items={files}
          limit={COLLAPSE_FILES}
          render={(f) => (
            <FileView
              key={f.path}
              path={f.path}
              executable={f.executable}
              options={skillFileQueryOptions(group, name, f.path, pin)}
              inlineText={f.path === "SKILL.md" ? skillMd : undefined}
              inlineCut={f.path === "SKILL.md" && skillMdCut}
            />
          )}
        />
      </ul>
    </Section>
  );
}

/** The "From …" line: a link to the Source peek, or plain text when the reader came from it. */
function FromLine({
  group,
  source,
  cameFromSource,
  onOpen,
}: {
  group: string;
  source: SkillRowView["source"];
  cameFromSource: boolean;
  onOpen(key: string): void;
}) {
  const id = group.startsWith("source:") ? group.slice("source:".length) : undefined;
  if (group === "host")
    return <p className="text-[0.8125rem] text-muted-foreground">From the host's skills folder</p>;
  if (group.startsWith("template:")) {
    const template = group.slice("template:".length);
    return (
      <p className="text-[0.8125rem] text-muted-foreground">
        From template{" "}
        <Link to="/templates/$name" params={{ name: template }} className={LINK}>
          {template}
        </Link>
      </p>
    );
  }
  if (id === undefined)
    return <p className="text-[0.8125rem] text-muted-foreground">Not found anywhere</p>;
  // Derived from the group, so a cold cache still has the link; the label and pin join when the list arrives.
  const pin = source ? pinLabel(source) : undefined;
  const text = source ? `From ${sourceLabel(source)}${pin ? ` · ${pin}` : ""}` : "From source";
  const key = sourceKey(id);
  return (
    <p className="text-[0.8125rem] text-muted-foreground">
      {cameFromSource ? (
        <UntrustedProse text={text} />
      ) : (
        <button
          type="button"
          data-peek-key={key}
          onClick={() => onOpen(key)}
          className={`${LINK} text-left`}
        >
          <UntrustedProse text={text} />
        </button>
      )}
    </p>
  );
}

/**
 * The Skill peek (spec §10.3). It renders from the cached list row at once (`select` from the module-level factory,
 * R-L2) and refines from the detail query: `detail ?? row`, skeletons for what the detail holds, never `initialData`,
 * `placeholderData` or an effect.
 */
export function SkillPeekBody({
  group,
  name,
  back,
  onBack,
  onOpen,
}: {
  group: string;
  name: string;
  back: string | null;
  onBack(): void;
  onOpen(key: string): void;
}) {
  const select = selectSkillRow(group, name); // memoised per (group, name) at module level
  const { data: cached } = useQuery({ ...libraryQueryOptions, select });
  const q = useQuery(skillQueryOptions(group, name));
  const detail = q.data;
  const row = detail ?? cached?.row;
  const source = cached?.source;
  const pin = source?.pin ?? null;
  return (
    <>
      <SheetHeader className="items-center">
        {back !== null && <BackButton onBack={onBack} />}
        <SheetTitle className="font-mono text-sm font-normal">
          <MiddleTruncate text={visibleControls(name)} />
        </SheetTitle>
      </SheetHeader>
      <SheetBody className="space-y-4">
        <div className="space-y-1">
          {row?.description && (
            <p className="text-sm">
              <UntrustedProse text={row.description} />
            </p>
          )}
          <FromLine
            group={group}
            source={source}
            cameFromSource={group.startsWith("source:") && back === sourceKey(group.slice(7))}
            onOpen={onOpen}
          />
          {row && row.state !== "ok" && (
            <p className="flex items-center gap-2 text-[0.8125rem]">
              <RowState state={row.state} />
              {row.stateDetail && <UntrustedProse text={row.stateDetail} />}
            </p>
          )}
        </div>
        {detail ? (
          <>
            {detail.hooks.length > 0 && <RunsCode hooks={detail.hooks} />}
            <UsedBySection users={detail.usedByTemplates} />
            <FilesSection
              group={group}
              name={name}
              files={detail.files}
              pin={pin}
              skillMd={detail.skillMd}
              skillMdCut={detail.skillMdCut}
            />
          </>
        ) : q.isError ? (
          <ErrorLine text={FORM_MSG.loadSkills} onRetry={() => void q.refetch()} />
        ) : (
          <SkeletonRows n={4} />
        )}
      </SheetBody>
    </>
  );
}
