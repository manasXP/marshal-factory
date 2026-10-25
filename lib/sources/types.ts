import type { JobRow } from "../../db/schema";
import type { Stage } from "../events";
import type { IntentDraft, Verdict } from "../webhooks";
import type { JobId, JobSource, SourceStateDraftOf, SourceStateOf, WritebackOf } from "./shapes";

export type { JobId, JobSource } from "./shapes";

export type Job<S extends JobSource = JobSource> = Omit<JobRow, "id" | "source" | "writeback" | "source_state"> & {
  id: JobId<S>;
  source: S;
  writeback: WritebackOf<S>;
  source_state: SourceStateOf<S>;
};

/** What a source reports for work it wants claimed; the claim turns it into a row. */
export type JobDraft<S extends JobSource = JobSource> = {
  externalId: string;
  key: string;
  title: string;
  url: string;
  description: string | null;
  writeback: WritebackOf<S>;
  /** Merged over the stored state on a reclaim, so state the adapter accumulated survives. */
  sourceState: SourceStateDraftOf<S>;
};

export type StageTransition = { stage: Stage; eventId: string };

export type Reply = { id: string; body: string; createdAt: string };

export type ResumePlan =
  | { kind: "wait" }
  | { kind: "close"; state: string }
  | { kind: "resume"; question: string; replies: Reply[]; answer: string };

export type StopReason = string;

export type StopCheck = { stop: false } | { stop: true; reopen: boolean };

export type WebhookScope = { teamKey: string; label: string };

export interface SourceWebhook {
  secretEnv: string;
  deliveryHeader: string;
  eventHeader: string;
  verify(raw: string, headers: Headers, secret: string, now?: number): Verdict;
  intent(body: unknown, scope: WebhookScope): IntentDraft | null;
}

export interface SourceAdapter<S extends JobSource> {
  source: S;
  webhook?: SourceWebhook;
  ready(): Promise<JobDraft<S>[]>;
  /** Tells the source the job's current attempt was picked up; does nothing once it has. */
  announceClaim(job: Job<S>): Promise<void>;
  /** Reports the stage to the source; false when the stage has nothing to say there. */
  writeBack(job: Job<S>, transition: StageTransition): Promise<boolean>;
  /** What a waiting job needs from what the source shows: wait, close, or resume with the new replies. */
  replies(job: Job<S>): Promise<ResumePlan>;
  acknowledgeReplies(job: Job<S>, replyIds: readonly string[]): Promise<void>;
  /** Of these jobs, the ones the source says should stop, with why. A failed read throws and decides nothing. */
  stopWanted(jobs: readonly Job<S>[]): Promise<{ job: Job<S>; reason: StopReason }[]>;
  /** Re-reads the source before a stop intent is acted on, so an unrelated change does not stop a run. */
  confirmStop(externalId: string, detail: string): Promise<StopCheck>;
  /** Returns a stopped job to the source's not-started state, so adding the label again retries it. */
  reopen(job: Job<S>): Promise<void>;
  /** The noun phrase naming the job in messages to the thread, such as "Linear issue FAC-7". */
  describe(job: Pick<Job<S>, "key">): string;
  /**
   * Rewrites the source's private image links in text sent to a thread into files on this machine,
   * since the agent cannot fetch them. Returns the text unchanged when it has none.
   */
  localizeImages?(job: Pick<Job<S>, "key">, text: string): Promise<string>;
  /** Files a new job in the source as a person would; the source's own intake then claims it. */
  file?(draft: FileDraft): Promise<FiledJob>;
  /** Stores an image where the source keeps uploads, for a job about to be filed; returns its markdown. */
  uploadImage?(image: ImageFile): Promise<string>;
}

export type FileDraft = { requestId: string; title: string; description: string };
export type ImageFile = { filename: string; contentType: string; bytes: Uint8Array<ArrayBuffer> };
export type FiledJob = { key: string; url: string };
