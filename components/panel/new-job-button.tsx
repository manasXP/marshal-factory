"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ExternalLinkIcon, PlusIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { Controller, useForm } from "react-hook-form";
import { createJob } from "@/app/actions/new-job";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { newJobSchema, type NewJob, type NewJobOutcome } from "@/lib/new-job-schema";

const blank = (): NewJob => ({ title: "", description: "", requestId: crypto.randomUUID() });

/** Starts a job by filing it in Linear, where the factory picks it up like any labeled issue. */
export function NewJobButton() {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<Extract<NewJobOutcome, { ok: true }> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const form = useForm<NewJob>({ resolver: zodResolver(newJobSchema), defaultValues: blank() });

  const reset = () => {
    form.reset(blank());
    setCreated(null);
    setFailure(null);
  };
  const submit = form.handleSubmit((values) => {
    setFailure(null);
    startTransition(async () => {
      const outcome = await createJob(values);
      if (outcome.ok) setCreated(outcome);
      else setFailure(outcome.message);
    });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon data-icon="inline-start" />
          New job
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.identifier} is filed</DialogTitle>
              <DialogDescription>
                The factory picks it up within a few seconds and it appears on the board in Queued.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" asChild>
                <a href={created.url} target="_blank" rel="noreferrer">
                  Open in Linear
                  <ExternalLinkIcon data-icon="inline-end" />
                </a>
              </Button>
              <Button onClick={reset}>Start another</Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-6">
            <DialogHeader>
              <DialogTitle>New job</DialogTitle>
              <DialogDescription>
                Files a Linear issue with the factory label. Questions and answers then happen on that issue.
              </DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Controller
                name="title"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="new-job-title">Title</FieldLabel>
                    <Input {...field} id="new-job-title" aria-invalid={fieldState.invalid} placeholder="Show the item count on the weight sort button" autoFocus />
                    {fieldState.error && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <Controller
                name="description"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="new-job-description">Description</FieldLabel>
                    <Textarea {...field} id="new-job-description" aria-invalid={fieldState.invalid} rows={6} placeholder="What should change, and how will you know it works?" />
                    <FieldDescription>The agent reads this as the spec. Markdown works.</FieldDescription>
                    {fieldState.error && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
            </FieldGroup>
            {failure && (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={pending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}
                File job
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
