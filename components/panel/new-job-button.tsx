"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ExternalLinkIcon, ImagePlusIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState, useTransition, type ClipboardEvent, type DragEvent } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { createJob } from "@/app/actions/new-job";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { EXECUTIONS, executionSchema } from "@/lib/execution";
import type { RepoSettingsRow } from "@/db/schema";
import type { Harness } from "@/lib/harness";
import { displayName } from "@/lib/repo-name";
import { RUNS_ON_LABELS } from "@/lib/ticket-overrides";
import { cn } from "@/lib/utils";
import {
  FILING_SOURCE_LABELS,
  FILING_SOURCES,
  filingSourceSchema,
  JOB_IMAGE_TYPES,
  MAX_JOB_IMAGE_BYTES,
  newJobSchema,
  type ImageUploadOutcome,
  type NewJob,
  type NewJobOutcome,
} from "@/lib/new-job-schema";

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

const SETTINGS_DEFAULT = "settings-default";

const sourceItems = FILING_SOURCES.map((s) => ({ value: s, label: FILING_SOURCE_LABELS[s] }));

const runsOnItems = [
  { value: SETTINGS_DEFAULT, label: "Settings default" },
  ...EXECUTIONS.map((e) => ({ value: e, label: RUNS_ON_LABELS[e] })),
];

/** Starts a job by filing it in Linear or as a GitHub issue, where the factory picks it up like any labeled issue. */
export function NewJobButton({ harnesses, repos }: { harnesses: readonly Harness[]; repos: readonly Pick<RepoSettingsRow, "repo" | "display_name" | "enabled" | "is_default">[] }) {
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<Extract<NewJobOutcome, { ok: true }> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const form = useForm<NewJob>({ resolver: zodResolver(newJobSchema), defaultValues: blank() });
  const [images, setImages] = useState<JobImage[]>([]);
  const [dragging, setDragging] = useState(false);
  const repoItems = repos.filter((r) => r.enabled).map((r) => ({ value: r.repo, label: displayName(r) }));
  const defaultRepo = repos.find((r) => r.is_default)?.repo ?? null;
  const harnessItems = [{ value: SETTINGS_DEFAULT, label: "Settings default" }, ...harnesses.map((h) => ({ value: h.id, label: h.name }))];
  const picker = useRef<HTMLInputElement>(null);
  const uploading = images.some((i) => i.status === "uploading");
  const source = useWatch({ control: form.control, name: "source" }) ?? "linear";
  // Images are stored in Linear, whose links GitHub readers and the agent on a GitHub job can't open.
  const takesImages = source === "linear";

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
    if (!takesImages) return;
    const files = imagesIn(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addImages(files);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    setDragging(false);
    if (!takesImages) return;
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
      <DialogTrigger render={<Button size="sm" />}>
        <PlusIcon data-icon="inline-start" />
        New job
      </DialogTrigger>
      <DialogPopup className="sm:max-w-lg">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{created.identifier} is filed</DialogTitle>
              <DialogDescription>
                The factory picks it up within a few seconds and it appears on the board in Queued.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" render={<a href={created.url} target="_blank" rel="noreferrer" />}>
                {created.source === "github" ? "Open on GitHub" : "Open in Linear"}
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
              <Button onClick={reset}>Start another</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New job</DialogTitle>
              <DialogDescription>
                Files {source === "github" ? "a GitHub issue" : "a Linear issue"} with the factory label. Questions and answers then happen on
                that issue. A harness or place other than the Settings default goes on the issue as its Harness or Runs on label.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={submit} className="contents">
              <DialogPanel className="flex flex-col gap-5">
                <Controller
                  name="title"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="new-job-title">Title</FieldLabel>
                      <Input {...field} id="new-job-title" aria-invalid={fieldState.invalid} placeholder="Show the item count on the weight sort button" autoFocus />
                      {fieldState.error && <FieldError match>{fieldState.error.message}</FieldError>}
                    </Field>
                  )}
                />
                <Controller
                  name="description"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field invalid={fieldState.invalid}>
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
                          if (!takesImages || !event.dataTransfer.types.includes("Files")) return;
                          event.preventDefault();
                          setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={onDrop}
                      />
                      <FieldDescription>
                        The agent reads this as the spec. Markdown works{takesImages ? "; paste or drop screenshots in." : "."}
                      </FieldDescription>
                      {fieldState.error && <FieldError match>{fieldState.error.message}</FieldError>}
                    </Field>
                  )}
                />
                <Controller
                  name="source"
                  control={form.control}
                  render={({ field }) => (
                    <Field>
                      <FieldLabel htmlFor="new-job-source">File in</FieldLabel>
                      <Select
                        items={sourceItems}
                        value={field.value ?? "linear"}
                        onValueChange={(v) => field.onChange(v === null ? undefined : filingSourceSchema.parse(v))}
                        disabled={images.length > 0}
                      >
                        <SelectTrigger id="new-job-source" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          {sourceItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      {images.length > 0 && <FieldDescription>Images go to Linear; remove them to file on GitHub.</FieldDescription>}
                    </Field>
                  )}
                />
                {repoItems.length > 0 && (
                  <Controller
                    name="repo"
                    control={form.control}
                    render={({ field }) => (
                      <Field>
                        <FieldLabel htmlFor="new-job-repo">Repository</FieldLabel>
                        <Select items={repoItems} value={field.value ?? defaultRepo} onValueChange={(v) => field.onChange(v ?? undefined)}>
                          <SelectTrigger id="new-job-repo" className="w-full">
                            <SelectValue placeholder="Pick a repository" />
                          </SelectTrigger>
                          <SelectPopup>
                            {repoItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                                <span className="font-mono text-xs text-muted-foreground">{item.value}</span>
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        <FieldDescription>
                          {source === "github" ? "The issue is filed in this repository." : "Goes on the issue as its Repository label, the default one included."}
                        </FieldDescription>
                      </Field>
                    )}
                  />
                )}
                <div className="grid grid-cols-2 gap-4">
                  <Controller
                    name="provider"
                    control={form.control}
                    render={({ field }) => (
                      <Field>
                        <FieldLabel htmlFor="new-job-harness">Harness</FieldLabel>
                        <Select
                          items={harnessItems}
                          value={field.value ?? SETTINGS_DEFAULT}
                          onValueChange={(v) => field.onChange(v === null || v === SETTINGS_DEFAULT ? undefined : v)}
                        >
                          <SelectTrigger id="new-job-harness" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            {harnessItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </Field>
                    )}
                  />
                  <Controller
                    name="execution"
                    control={form.control}
                    render={({ field }) => (
                      <Field>
                        <FieldLabel htmlFor="new-job-runs-on">Runs on</FieldLabel>
                        <Select
                          items={runsOnItems}
                          value={field.value ?? SETTINGS_DEFAULT}
                          onValueChange={(v) => field.onChange(v === null || v === SETTINGS_DEFAULT ? undefined : executionSchema.parse(v))}
                        >
                          <SelectTrigger id="new-job-runs-on" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectPopup>
                            {runsOnItems.map((item) => (
                              <SelectItem key={item.value} value={item.value}>
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </Field>
                    )}
                  />
                </div>
                {takesImages && (
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
                )}
                {failure && (
                  <p role="alert" className="text-sm text-destructive">
                    {failure}
                  </p>
                )}
              </DialogPanel>
              <DialogFooter>
                <DialogClose disabled={pending} render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button type="submit" disabled={pending || uploading}>
                  {(pending || uploading) && <Spinner data-icon="inline-start" />}
                  {uploading ? "Uploading images" : "File job"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
