import { ENV_NAME, isFactoryEnvName } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type KeyboardEvent, memo, useCallback, useId, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { FieldShell } from "@/components/field-shell";
import { Button } from "@/components/ui/button";
import type { ComboOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { secretsQueryOptions } from "@/features/settings/api";
import { openSheetForResult, returnFocusAfterChild } from "@/features/sheets/sheet-store";
import { IssueIcon } from "@/features/templates/issue-list";
import { cn } from "@/lib/utils";
import type { AddSlot, RowNote } from "./config-list";
import { FIELD_PATHS } from "./fields";
import { ListField } from "./list-field";
import { CONFIG_COPY, CONFIG_FIELD_MSG } from "./messages";
import { PickAdd, pickEmpty } from "./pick-add";
import { useConfigScope, useFieldNote } from "./scope";
import { Section, WrongType } from "./section";
import { isRec, readAt, readList } from "./tolerant";

const ENV = FIELD_PATHS.env;
const NONE: readonly string[] = [];

/** An env name's client rule (spec §5.1): the name pattern, and never a name the factory sets itself. */
export function envNameError(name: string): string | undefined {
  if (!ENV_NAME.test(name)) return CONFIG_FIELD_MSG.envName;
  if (isFactoryEnvName(name)) return CONFIG_FIELD_MSG.factoryEnv;
  return undefined;
}

const availableAs = (name: string) => (
  <>
    Available as <span className="font-mono text-[0.8125rem]">${name}</span>
  </>
);

/** Spec §12.2 section 5: plain variables (`settings.env`) and env from secrets (`template.secrets`). */
export function EnvironmentSection() {
  return (
    <Section title="Environment">
      <EnvField />
      <ListField
        field="envSecrets"
        label="From secrets"
        noun="secret"
        format={availableAs}
        check={envNameError}
        rowCheck={envNameError}
        renderAdd={(slot) => <SecretPicker slot={slot} />}
      />
    </Section>
  );
}

/**
 * Plain variables, written to settings.json as text. A value is shown only inside its own input; a name is fixed
 * once added (remove and add again to rename), so a half-typed name never moves the entry.
 */
function EnvField() {
  const s = useConfigScope();
  const note = useFieldNote("env");
  const { update, fieldErrors, readOnly } = s;
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const nameEl = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLUListElement>(null);
  const groupId = useId();

  const own = readAt(s.value, ENV);
  const ownRec = own.ok && (own.value === undefined || isRec(own.value)) ? own.value : null;
  const ownEntries = useMemo(() => (isRec(ownRec) ? Object.entries(ownRec) : []), [ownRec]);
  const tplRead = s.base ? readAt(s.base, ENV) : null;
  const tplRaw = tplRead ? (tplRead.ok ? tplRead.value : undefined) : null;
  const tplNames = useMemo(
    () => (tplRaw === null ? null : isRec(tplRaw) ? Object.keys(tplRaw) : []),
    [tplRaw],
  );
  const ownNames = useMemo(() => new Set(ownEntries.map(([n]) => n)), [ownEntries]);
  const items = s.byField.get("env")?.items;
  const notes = useMemo(() => {
    const m = new Map<string, RowNote>();
    for (const [n] of ownEntries) {
      const note = rowNote(n, items?.get(n));
      if (note) m.set(n, note);
    }
    return m;
  }, [ownEntries, items]);

  const setOne = useCallback((n: string, v: string) => update([...ENV, n], () => v), [update]);
  const remove = useCallback(
    (n: string, index: number) => {
      flushSync(() => update([...ENV, n], () => undefined));
      const rows = listEl.current?.children;
      const row = rows?.[index] ?? rows?.[index - 1];
      (row?.querySelector<HTMLElement>("button[data-remove]") ?? nameEl.current)?.focus();
    },
    [update],
  );

  if (ownRec === null) return <WrongType field="env" label="Plain variables" />;

  const add = () => {
    const n = name.trim();
    if (!n) return;
    const bad = envNameError(n) ?? (ownNames.has(n) ? CONFIG_FIELD_MSG.duplicate : undefined);
    if (bad) {
      fieldErrors.set("env", bad);
      return;
    }
    flushSync(() => {
      setOne(n, value);
      setName("");
      setValue("");
    });
    nameEl.current?.focus();
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    add();
  };

  const ownList = (
    <ul ref={listEl} aria-labelledby={tplNames ? `${groupId}-own` : undefined} className="grid">
      {ownEntries.map(([n, v], i) => (
        <EnvRow
          key={n}
          name={n}
          value={v}
          index={i}
          note={notes.get(n)}
          readOnly={readOnly}
          onValue={setOne}
          onRemove={remove}
        />
      ))}
    </ul>
  );

  return (
    <FieldShell
      name="env"
      label="Plain variables"
      legend
      help={CONFIG_COPY.envHelp}
      error={note.error}
      warning={note.warning}
    >
      {({ id, describedBy, invalid }) => (
        <div className="grid gap-2">
          {tplNames ? (
            <div className="grid gap-1">
              <p id={`${groupId}-tpl`} className="text-[0.8125rem] text-muted-foreground">
                {s.inheritedLabel} · {tplNames.length}
              </p>
              <ul aria-labelledby={`${groupId}-tpl`} className="grid">
                {tplNames.map((n) => (
                  <li
                    key={n}
                    className="flex min-h-8 items-start gap-2 px-2 pointer-coarse:min-h-10"
                  >
                    <span className="min-w-0 flex-1 py-1.5 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
                      {n}
                    </span>
                    {ownNames.has(n) ? (
                      <span className="shrink-0 py-1.5 text-[0.8125rem] text-muted-foreground">
                        {CONFIG_COPY.overridden}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {tplNames ? (
            <div className="grid gap-1">
              <p id={`${groupId}-own`} className="text-[0.8125rem] text-muted-foreground">
                {CONFIG_COPY.thisAgent} · {ownEntries.length}
              </p>
              {ownList}
            </div>
          ) : (
            ownList
          )}
          {readOnly ? null : (
            <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] md:items-center">
              <Input
                ref={nameEl}
                id={id}
                value={name}
                placeholder="NAME"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                aria-label="Add variable name"
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  fieldErrors.change("env");
                }}
                onKeyDown={onEnter}
              />
              <Input
                value={value}
                placeholder="value"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                aria-label="Add variable value"
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={onEnter}
              />
              <Button type="button" variant="ghost" inForm onClick={add}>
                Add
              </Button>
            </div>
          )}
        </div>
      )}
    </FieldShell>
  );
}

/** A row's note: the client rule first (it is about the name as it is now), then a server issue on that name. */
function rowNote(name: string, server: RowNote | undefined): RowNote | undefined {
  const own = envNameError(name);
  return own ? { message: own, severity: "error" } : server;
}

const EnvRow = memo(function EnvRow({
  name,
  value,
  index,
  note,
  readOnly,
  onValue,
  onRemove,
}: {
  name: string;
  value: unknown;
  index: number;
  note?: RowNote;
  readOnly: boolean;
  onValue: (name: string, value: string) => void;
  onRemove: (name: string, index: number) => void;
}) {
  const noteId = useId();
  return (
    <li className="grid gap-1 px-2 py-1 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] md:items-start md:gap-2">
      <span className="min-w-0 py-1.5 font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
        {name}
      </span>
      {typeof value === "string" ? (
        <Input
          value={value}
          readOnly={readOnly}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          aria-label={`Value of ${name}`}
          aria-describedby={note ? noteId : undefined}
          onChange={(e) => onValue(name, e.target.value)}
        />
      ) : (
        <span className="py-1.5 text-[0.8125rem] text-muted-foreground">
          {CONFIG_FIELD_MSG.editInRaw}
        </span>
      )}
      {readOnly ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="justify-self-end"
          data-remove=""
          aria-label={`Remove variable ${name}`}
          aria-describedby={note ? noteId : undefined}
          onClick={() => onRemove(name, index)}
        >
          <X aria-hidden="true" />
        </Button>
      )}
      {note ? (
        <p
          id={noteId}
          className={cn(
            "flex items-start gap-1.5 text-[0.8125rem] md:col-span-3",
            note.severity === "error" ? "text-destructive" : "text-foreground",
          )}
        >
          <IssueIcon severity={note.severity} />
          <span className="min-w-0 [overflow-wrap:anywhere]">{note.message}</span>
        </p>
      ) : null}
    </li>
  );
});

function SecretPicker({ slot }: { slot: AddSlot }) {
  const q = useQuery(secretsQueryOptions);
  const { value, base } = useConfigScope();
  const own = readList(readAt(value, FIELD_PATHS.envSecrets));
  const tpl = base ? readList(readAt(base, FIELD_PATHS.envSecrets)) : null;
  const ownItems = own.ok ? own.items : NONE;
  const tplItems = tpl?.ok ? tpl.items : NONE;
  const options = useMemo(() => {
    const taken = new Set([...ownItems, ...tplItems]);
    return (q.data ?? [])
      .filter((x) => !taken.has(x.name))
      .map((x): ComboOption => ({ value: x.name, label: x.name }));
  }, [q.data, ownItems, tplItems]);
  const addSecret = () =>
    openSheetForResult({ kind: "add-secret", name: "" }, (name) => {
      slot.add(name);
      returnFocusAfterChild(() => document.getElementById(slot.id));
    });
  return (
    <PickAdd
      slot={slot}
      label="Add secret to environment"
      placeholder="Pick a secret"
      options={options}
      emptyText={pickEmpty(q, "No more secrets.")}
      extra={
        <Button type="button" variant="ghost" inForm onClick={addSecret}>
          {CONFIG_COPY.addSecret}
        </Button>
      }
    />
  );
}
