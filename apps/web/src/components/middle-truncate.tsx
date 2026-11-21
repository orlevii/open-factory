/** Long paths: the head shrinks with an ellipsis, then the last segment (only when it alone is too wide). */
export function MiddleTruncate({ text }: { text: string }) {
  const i = text.lastIndexOf("/");
  const head = i > 0 ? text.slice(0, i) : text;
  const tail = i > 0 ? text.slice(i) : "";
  return (
    <span className="flex min-w-0">
      <span aria-hidden="true" className="truncate">
        {head}
      </span>
      {/* The head goes first; the tail truncates only once the head is gone and it alone is too wide. */}
      <span aria-hidden="true" className="max-w-full shrink-0 truncate">
        {tail}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
