import type { ImageItem } from "@open-factory/shared";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { buildImage, imagesQueryOptions } from "./api";
import { BuildLog } from "./build-log";
import { ImageStatusLabel } from "./image-status";

const small = "text-[0.8125rem] leading-[1.125rem]";
const code = "font-mono text-[0.8125rem]";

/** Spec §12.8: one row per folder in `images/`, with its build actions and an inline log. */
export function ImagesSection() {
  const { data, isError, isPending } = useQuery(imagesQueryOptions);
  const hash = useLocation({ select: (l) => l.hash });

  // #images (the header link, a start error's fix link): bring the section into view once its
  // content is there, and move focus to its heading.
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (hash !== "images") {
      handled.current = undefined;
      return;
    }
    if (isPending || handled.current === hash) return;
    handled.current = hash;
    document.getElementById("images")?.scrollIntoView?.({ block: "start" });
    document.getElementById("images-title")?.focus();
  }, [hash, isPending]);

  return (
    <section id="images" aria-labelledby="images-title" className="mt-4 grid gap-3 scroll-mt-4">
      <h2
        id="images-title"
        tabIndex={-1}
        className="font-heading text-[0.9375rem] font-semibold focus-visible:outline-none" // ui-contract:allow programmatic focus target, not interactive
      >
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
        <p className="text-sm text-muted-foreground">
          No images yet. Add a Dockerfile at{" "}
          <code className={code}>{`${data.imagesDir}/<name>/Dockerfile`}</code>, starting FROM{" "}
          <code className={code}>{data.baseImage}</code>.
        </p>
      )}
      {data && data.images.length > 0 && (
        <ul className="divide-y divide-border border-y border-border">
          {data.images.map((i) => (
            <ImageRow key={i.name} item={i} />
          ))}
        </ul>
      )}
      {data && (
        <p className={`${small} text-muted-foreground`}>
          Agents use a rebuilt image from their next start.
        </p>
      )}
    </section>
  );
}

function ImageRow({ item }: { item: ImageItem }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const logId = `image-log-${item.name}`;
  const exists = item.status === "built" || item.status === "out_of_date" || !!item.builtAt;
  // Rendered while building too (aria-disabled), so a focused Build keeps focus as the status flips.
  const canBuild = item.status !== "no_dockerfile";
  const building = item.status === "building";
  const hasLog = item.status === "building" || !!item.lastBuild;

  const build = async () => {
    setError(undefined);
    // Open first: the panel subscribes to the build's frames before they can arrive.
    setOpen(true);
    try {
      await buildImage(item.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <li className="grid gap-2 px-2 py-2">
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
          {canBuild && (
            <Button
              variant="ghost"
              size="sm"
              aria-disabled={building || undefined}
              onClick={() => !building && void build()}
            >
              {exists ? "Rebuild" : "Build"}
            </Button>
          )}
          {(hasLog || open) && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={open ? logId : undefined}
              onClick={() => setOpen((o) => !o)}
            >
              View log
            </Button>
          )}
        </span>
      </div>
      {error && (
        <p role="alert" className={`flex items-center gap-1.5 ${small} text-destructive`}>
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          {error}
        </p>
      )}
      {open && (
        <div id={logId}>
          <BuildLog name={item.name} item={item} />
        </div>
      )}
    </li>
  );
}
