import type { FocusEvent, KeyboardEventHandler, ReactNode, Ref } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "./markdown";

const triggerClass =
  "h-full flex-none rounded-none px-2 text-[0.8125rem] font-normal text-muted-foreground data-[state=active]:text-foreground group-data-horizontal/tabs:after:bottom-0";

/** Raw markdown with Write / Preview tabs, one bordered unit (UI design §7.5). The optional
 *  props go to the textarea so forms can label and describe it. */
export function MarkdownEditor(props: {
  value: string;
  onChange(v: string): void;
  id?: string;
  placeholder?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  onBlur?(e: FocusEvent<HTMLTextAreaElement>): void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Controlled Write / Preview, for callers that must jump into the textarea. */
  view?: "write" | "preview";
  onViewChange?(v: "write" | "preview"): void;
  /** The look of the Preview tab: pass what the saved text renders with. */
  variant?: "default" | "detail";
  /** A shorter starting height (it still resizes), for a composer that shares a pane. */
  compact?: boolean;
  /** Replaces the Write textarea (the template editor's CodeMirror); without it, the textarea. */
  writeSurface?: (p: {
    value: string;
    onChange(v: string): void;
    describedBy?: string;
  }) => ReactNode;
  /** Geist instead of mono in the textarea, for prose a person writes (a message, not code). */
  proportional?: boolean;
  invalid?: boolean;
}) {
  const { value, onChange, id, placeholder, view, onViewChange } = props;
  const minH = props.compact ? "min-h-24" : "min-h-40";
  return (
    <Tabs
      {...(view
        ? { value: view, onValueChange: (v: string) => onViewChange?.(v as "write" | "preview") }
        : { defaultValue: "write" })}
      data-invalid={props.invalid || undefined}
      className="field-edge-transition gap-0 overflow-hidden rounded-lg border border-input bg-card data-[invalid]:border-destructive focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20" // ui-contract:allow the frame shows focus-within; the textarea inside has no ring of its own
    >
      <TabsList className="h-9! w-full justify-start gap-1 rounded-none border-b bg-muted/50 p-0 px-2">
        <TabsTrigger value="write" className={triggerClass}>
          Write
        </TabsTrigger>
        <TabsTrigger value="preview" className={triggerClass}>
          Preview
        </TabsTrigger>
        <span aria-hidden="true" className="ml-auto pr-1 text-xs text-muted-foreground">
          Markdown supported
        </span>
      </TabsList>
      <TabsContent value="write" className="mt-0">
        {props.writeSurface ? (
          props.writeSurface({ value, onChange, describedBy: props["aria-describedby"] })
        ) : (
          <Textarea
            id={id}
            ref={props.textareaRef}
            onBlur={props.onBlur}
            onKeyDown={props.onKeyDown}
            placeholder={placeholder}
            // Without an id there is no <Label htmlFor>, so fall back to a built-in name.
            aria-label={props["aria-label"] ?? (id ? undefined : "Markdown")}
            aria-describedby={props["aria-describedby"]}
            aria-invalid={props.invalid || undefined}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={`field-sizing-fixed ${minH} resize-y rounded-none border-0 bg-transparent p-3 ${props.proportional ? "" : "font-mono "}text-[0.8125rem] leading-5 shadow-none focus-visible:ring-0 focus-visible:outline-none md:text-[0.8125rem] dark:bg-transparent`} // ui-contract:allow the frame shows focus-within
          />
        )}
      </TabsContent>
      <TabsContent value="preview" className={`mt-0 ${minH} p-3`}>
        {value.trim() === "" ? (
          <p className="text-sm text-muted-foreground">Nothing to preview.</p>
        ) : (
          <Markdown source={value} variant={props.variant ?? "default"} />
        )}
      </TabsContent>
    </Tabs>
  );
}
