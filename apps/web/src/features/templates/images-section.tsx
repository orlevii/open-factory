import type { ImageItem } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { memo, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { buildImage, imagesQueryOptions } from "./api";
import { BuildLog } from "./build-log";
import { ImageStatusLabel } from "./image-status";

const small = "text-[0.8125rem] leading-[1.125rem]";
const code = "font-mono text-[0.8125rem]";
const NO_IMAGES: readonly ImageItem[] = [];

/** Spec §12.8, U2 §14: the Images view, one row per folder in `images/`, with its build actions; the
 *  build log opens in a side panel. */
export function ImagesSection() {
  const { data, isError } = useQuery(imagesQueryOptions);
  const [logFor, setLogFor] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const closeLog = useCallback(() => setLogFor(null), []);
  const trigger = useCallback(
    (name: string) =>
      [...(list.current?.querySelectorAll<HTMLElement>("[data-build-log-for]") ?? [])].find(
        (el) => el.dataset.buildLogFor === name,
      ) ?? null,
    [],
  );
  return (
    // While the log is open the view keeps the panel's 30rem clear, so every row's Build and Build log
    // stay under the pointer (retarget by click). Only where 24rem of list is left beside it (the task
    // peek's rule); narrower, the panel overlays. The container is the wrapper, so the padding can't
    // feed back into the query. No transition: the panel slides, the list doesn't.
    <div className="@container">
      <section
        aria-labelledby="images-title"
        data-log-open={logFor !== null || undefined}
        className="grid grid-cols-[minmax(0,1fr)] gap-3 @[54rem]:data-log-open:pr-[30rem]"
      >
        {/* The header's Templates | Images switch already shows the view's name; the heading only labels
            the section (and keeps the page outline) for assistive tech. */}
        <h2 id="images-title" className="sr-only">
          Images
        </h2>
        {isError && !data && (
          <p role="alert" className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
            Couldn't load images.
          </p>
        )}
        {data?.images.some((i) => i.status === "unknown") && (
          <p className={`flex items-start gap-1.5 ${small}`}>
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
            Docker isn't reachable. Check that the daemon is running and the server can reach its
            socket.
          </p>
        )}
        {data && data.images.length === 0 && (
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            No images yet. Add a Dockerfile at{" "}
            <code className={code}>{`${data.imagesDir}/<name>/Dockerfile`}</code>, starting FROM{" "}
            <code className={code}>{data.baseImage}</code>.
          </p>
        )}
        {data && data.images.length > 0 && (
          <ul ref={list} className="divide-y divide-border border-y border-border">
            {data.images.map((i) => (
              <ImageRow key={i.name} item={i} onOpenLog={setLogFor} />
            ))}
          </ul>
        )}
        {data && (
          <p className={`${small} text-muted-foreground`}>
            Agents use a rebuilt image from their next start.
          </p>
        )}
        <BuildLogSheet
          name={logFor}
          images={data?.images ?? NO_IMAGES}
          onClose={closeLog}
          trigger={trigger}
        />
      </section>
    </div>
  );
}

/** One build action for a row and the log panel's footer: Build or Rebuild, rendered while building
 *  too (aria-disabled), so a focused button keeps focus as the status flips. */
function useBuildAction(item: ImageItem) {
  const [error, setError] = useState<string>();
  const building = item.status === "building";
  const exists = item.status === "built" || item.status === "out_of_date" || !!item.builtAt;
  const start = async () => {
    if (building) return;
    setError(undefined);
    try {
      await buildImage(item.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return {
    can: item.status !== "no_dockerfile",
    building,
    label: exists ? "Rebuild" : "Build",
    start,
    error,
  };
}

function BuildButton({ action }: { action: ReturnType<typeof useBuildAction> }) {
  if (!action.can) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-disabled={action.building || undefined}
      onClick={() => void action.start()}
    >
      {action.label}
    </Button>
  );
}

function BuildError({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <p role="alert" className={`flex items-center gap-1.5 ${small} text-destructive`}>
      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      {text}
    </p>
  );
}

const ImageRow = memo(function ImageRow({
  item,
  onOpenLog,
}: {
  item: ImageItem;
  onOpenLog(name: string): void;
}) {
  const action = useBuildAction(item);
  return (
    <li className="grid grid-cols-[minmax(0,1fr)] gap-2 px-2 py-2">
      <div className="flex min-h-7 flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span data-image-name className={code}>
          {item.name}
        </span>
        {/* State changes are announced here, not by the log (aria-live="off" there). */}
        <span aria-live="polite" className={small}>
          <ImageStatusLabel status={item.status} builtAt={item.builtAt} />
        </span>
        {item.usedBy.length > 0 && (
          <span className={`${small} text-muted-foreground`}>Used by {item.usedBy.join(", ")}</span>
        )}
        <span className="ml-auto flex gap-2">
          <BuildButton action={action} />
          {(action.can || item.lastBuild) && (
            <Button
              variant="ghost"
              size="sm"
              data-build-log-for={item.name}
              onClick={() => onOpenLog(item.name)}
            >
              Build log
            </Button>
          )}
        </span>
      </div>
      <BuildError text={action.error} />
    </li>
  );
});

/**
 * Spec §14: the build log in a peek. A non-modal sheet (the rows and the shortcut layer stay live) that
 * stays mounted while `name` changes: another row's Build log retargets it in place, and only the body
 * is keyed, so the new image's log never starts from the last one's lines. `null` closes it (the last
 * image stays shown while it leaves); focus returns to that image's Build log button.
 */
function BuildLogSheet({
  name,
  images,
  onClose,
  trigger,
}: {
  name: string | null;
  images: readonly ImageItem[];
  onClose(): void;
  trigger(name: string): HTMLElement | null;
}) {
  const [shown, setShown] = useState(name);
  if (name !== null && name !== shown) setShown(name);
  const item = shown === null ? undefined : images.find((i) => i.name === shown);
  return (
    <Sheet
      open={name !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      modal={false}
    >
      <SheetContent
        aria-describedby={undefined}
        returnFocus={() => (shown === null ? null : trigger(shown))}
      >
        {shown !== null && (
          <>
            <SheetHeader>
              <SheetTitle>{shown} build log</SheetTitle>
            </SheetHeader>
            {/* Sized to the log, not the panel: the footer's Build sits right under the card instead of
                at the bottom of a tall, mostly empty panel. It still shrinks and scrolls when short. */}
            <SheetBody key={shown} className="flex-initial">
              <BuildLog name={shown} item={item} />
            </SheetBody>
            {item && <BuildLogFooter key={`${shown}-footer`} item={item} />}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function BuildLogFooter({ item }: { item: ImageItem }) {
  const action = useBuildAction(item);
  if (!action.can) return null;
  return (
    <SheetFooter className="items-center">
      <BuildError text={action.error} />
      <BuildButton action={action} />
    </SheetFooter>
  );
}
