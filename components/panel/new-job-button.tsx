"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ExternalLinkIcon, ImagePlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState, useTransition, type ClipboardEvent, type DragEvent } from "react";
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
import { cn } from "@/lib/utils";
import { JOB_IMAGE_TYPES, MAX_JOB_IMAGE_BYTES, newJobSchema, type ImageUploadOutcome, type NewJob, type NewJobOutcome } from "@/lib/new-job-schema";

const blank = (): NewJob => ({ title: "", description: "", requestId: crypto.randomUUID() });

type JobImage = { id: string; name: string; preview: string } & (
  | { status: "uploading" }
  | { status: "done"; markdown: string }
  | { status: "failed"; message: string }
);

const imagesIn = (files: Iterable<File>) => [...files].filter((f) => f.type.startsWith("image/"));

async function uploadImage(file: File): Promise<ImageUploadOutcome> {
  if (!(JOB_IMAGE_TYPES as readonly string[]).includes(file.type)) return { ok: false, status: 400, message: "Only PNG, JPEG, WebP and GIF images." };
  if (file.size > MAX_JOB_IMAGE_BYTES) return { ok: false, status: 413, message: "Larger than 4 MB." };
  const body = new FormData();
  body.set("image", file);
  const res = await fetch("/api/jobs/images", { method: "POST", body }).catch(() => null);
  if (!res) return { ok: false, status: 502, message: "The upload did not reach the panel." };
  return (await res.json().catch(() => ({ ok: false, status: 502, message: `The panel answered ${res.status}.` }))) as ImageUploadOutcome;
}

/** Starts a job by filing it in Linear, where the factory picks it up like any labeled issue. */
export function NewJobButton() {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<Extract<NewJobOutcome, { ok: true }> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const form = useForm<NewJob>({ resolver: zodResolver(newJobSchema), defaultValues: blank() });
  const [images, setImages] = useState<JobImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const uploading = images.some((i) => i.status === "uploading");

  const reset = () => {
    form.reset(blank());
    setCreated(null);
    setFailure(null);
    setImages((current) => {
      for (const image of current) URL.revokeObjectURL(image.preview);
      return [];
    });
  };

  // Each image goes to Linear as it is added; its markdown joins the description, as Linear's editor would write it.
  const addImages = (files: File[]) => {
    const draft = form.getValues("requestId");
    for (const file of files) {
      const id = crypto.randomUUID();
      setImages((current) => [...current, { id, name: file.name, preview: URL.createObjectURL(file), status: "uploading" }]);
      void uploadImage(file).then((outcome) => {
        // The dialog was closed or reopened while this uploaded; the image belongs to a draft that is gone.
        if (form.getValues("requestId") !== draft) return;
        if (outcome.ok) {
          const description = form.getValues("description").trimEnd();
          form.setValue("description", description ? `${description}\n\n${outcome.markdown}` : outcome.markdown, { shouldValidate: true });
        }
        setImages((current) =>
          current.map((image) =>
            image.id !== id ? image : outcome.ok ? { ...image, status: "done", markdown: outcome.markdown } : { ...image, status: "failed", message: outcome.message },
          ),
        );
      });
    }
  };
  const removeImage = (image: JobImage) => {
    if (image.status === "done") {
      const description = form.getValues("description").replace(image.markdown, "").replace(/\n{3,}/g, "\n\n").trim();
      form.setValue("description", description, { shouldValidate: true });
    }
    URL.revokeObjectURL(image.preview);
    setImages((current) => current.filter((i) => i.id !== image.id));
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imagesIn(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addImages(files);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    setDragging(false);
    const files = imagesIn(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    addImages(files);
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
                    <Textarea
                      {...field}
                      id="new-job-description"
                      aria-invalid={fieldState.invalid}
                      rows={6}
                      placeholder="What should change, and how will you know it works?"
                      className={cn(dragging && "border-primary ring-1 ring-primary")}
                      onPaste={onPaste}
                      onDragOver={(event) => {
                        if (!event.dataTransfer.types.includes("Files")) return;
                        event.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={onDrop}
                    />
                    <FieldDescription>The agent reads this as the spec. Markdown works; paste or drop screenshots in.</FieldDescription>
                    {fieldState.error && <FieldError errors={[fieldState.error]} />}
                  </Field>
                )}
              />
              <div className="flex flex-wrap items-start gap-2">
                {images.map((image) => (
                  <div key={image.id} className="flex flex-col gap-1">
                    <div className={cn("relative size-16 overflow-hidden rounded-md border", image.status === "failed" && "border-destructive")}>
                      {/* A local preview of a file the owner just picked; next/image has nothing to optimize here. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={image.preview} alt={image.name} className={cn("size-full object-cover", image.status === "uploading" && "opacity-50")} />
                      {image.status === "uploading" && <Spinner className="absolute inset-0 m-auto" />}
                      {image.status !== "uploading" && (
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="secondary"
                          className="absolute top-0.5 right-0.5"
                          aria-label={`Remove ${image.name}`}
                          onClick={() => removeImage(image)}
                        >
                          <XIcon />
                        </Button>
                      )}
                    </div>
                    {image.status === "failed" && <span className="max-w-16 text-xs text-destructive">{image.message}</span>}
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => picker.current?.click()}>
                  <ImagePlusIcon data-icon="inline-start" />
                  Add image
                </Button>
                <input
                  ref={picker}
                  type="file"
                  accept={JOB_IMAGE_TYPES.join(",")}
                  multiple
                  hidden
                  onChange={(event) => {
                    addImages(imagesIn(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
              </div>
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
              <Button type="submit" disabled={pending || uploading}>
                {(pending || uploading) && <Spinner data-icon="inline-start" />}
                {uploading ? "Uploading images" : "File job"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
