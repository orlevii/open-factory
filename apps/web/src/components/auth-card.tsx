import type { FormEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function AuthCard(props: {
  title: string;
  submitLabel: string;
  submitting: boolean;
  formError?: string;
  onSubmit(): void;
  footer: ReactNode;
  children: ReactNode;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    props.onSubmit();
  };
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <p className="text-muted-foreground text-sm">Open Factory</p>
          <CardTitle className="text-xl">{props.title}</CardTitle>
        </CardHeader>
        <form onSubmit={submit} noValidate>
          <CardContent className="grid gap-4">
            {props.children}
            {props.formError && (
              <p role="alert" className="text-destructive text-sm">
                {props.formError}
              </p>
            )}
            <Button type="submit" disabled={props.submitting}>
              {props.submitLabel}
            </Button>
          </CardContent>
        </form>
        <CardFooter className="text-muted-foreground text-sm">{props.footer}</CardFooter>
      </Card>
    </main>
  );
}
