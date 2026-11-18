import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "./markdown";

export function MarkdownEditor({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <Tabs defaultValue="write">
      <TabsList>
        <TabsTrigger value="write">Write</TabsTrigger>
        <TabsTrigger value="preview">Preview</TabsTrigger>
      </TabsList>
      <TabsContent value="write">
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-40 font-mono"
        />
      </TabsContent>
      <TabsContent value="preview">
        <Markdown source={value} />
      </TabsContent>
    </Tabs>
  );
}
