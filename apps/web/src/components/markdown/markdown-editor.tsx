import type { KeyboardEventHandler, Ref } from "react";
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
  onBlur?(): void;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  textareaRef?: Ref<HTMLTextAreaElement>;
  /** Controlled Write / Preview, for callers that must jump into the textarea. */
  view?: "write" | "preview";
  onViewChange?(v: "write" | "preview"): void;
}) {
  const { value, onChange, id, placeholder, view, onViewChange } = props;
  return (
    <Tabs
      {...(view
        ? { value: view, onValueChange: (v: string) => onViewChange?.(v as "write" | "preview") }
        : { defaultValue: "write" })}
      className="gap-0 overflow-hidden rounded-lg border border-input bg-card transition-[box-shadow,border-color] duration-150 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20"
    >
      <TabsList
        variant="line"
        className="h-9! w-full justify-start gap-1 rounded-none border-b bg-muted/50 p-0 px-2"
      >
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
        <Textarea
          id={id}
          ref={props.textareaRef}
          onBlur={props.onBlur}
          onKeyDown={props.onKeyDown}
          placeholder={placeholder}
          // Without an id there is no <Label htmlFor>, so fall back to a built-in name.
          aria-label={props["aria-label"] ?? (id ? undefined : "Markdown")}
          aria-describedby={props["aria-describedby"]}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="field-sizing-fixed min-h-40 resize-y rounded-none border-0 bg-transparent p-3 font-mono text-[0.8125rem] leading-5 shadow-none focus-visible:ring-0 focus-visible:outline-none md:text-[0.8125rem] dark:bg-transparent"
        />
      </TabsContent>
      <TabsContent value="preview" className="mt-0 min-h-40 p-3">
        {value.trim() === "" ? (
          <p className="text-sm text-muted-foreground">Nothing to preview.</p>
        ) : (
          <Markdown source={value} />
        )}
      </TabsContent>
    </Tabs>
  );
}
