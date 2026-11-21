import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function PasswordInput({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        type={shown ? "text" : "password"}
        className={cn("h-9 pr-10 font-mono", className)}
        {...props}
        // After the spread: no caller turns the password-manager opt-out back on.
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={shown ? "Hide value" : "Show value"}
        onClick={() => setShown((s) => !s)}
        className="absolute top-1 right-1"
      >
        {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </Button>
    </div>
  );
}
