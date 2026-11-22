/** Long paths: the head shrinks with an ellipsis, then the last segment (only when it alone is too
 *  wide). Text with no inner "/" (a handle) splits at its middle, so "@marketing-team" reads
 *  "@ma…ng-team": its head and tail both stay. */
export function MiddleTruncate({
  text,
  keepEnd = false,
}: {
  text: string;
  /** A file name: once its last segment alone is too wide, it cuts from the start, so the
   *  extension stays. */
  keepEnd?: boolean;
}) {
  const slash = text.lastIndexOf("/");
  const i = slash > 0 ? slash : Math.ceil(text.length / 2);
  const head = text.slice(0, i);
  const tail = text.slice(i);
  return (
    <span className="flex min-w-0">
      <span aria-hidden="true" className="truncate">
        {head}
      </span>
      {/* The head goes first; the tail truncates only once the head is gone and it alone is too wide. */}
      {keepEnd ? (
        // A right-to-left box puts the ellipsis at the start; the text inside stays left-to-right.
        <span aria-hidden="true" dir="rtl" className="max-w-full shrink-0 truncate text-left">
          <span dir="ltr">{tail}</span>
        </span>
      ) : (
        <span aria-hidden="true" className="max-w-full shrink-0 truncate">
          {tail}
        </span>
      )}
      <span className="sr-only">{text}</span>
    </span>
  );
}
