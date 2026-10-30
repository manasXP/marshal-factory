import type { JobRow } from "../db/schema";
import { causeOf } from "./stages";

// Each attempt has a spend limit in USD (jobs.budget_usd), set from Settings when it is claimed.
// When its measured spend reaches the limit, the runner pauses it: the job waits with a question,
// and the owner's answer sets a new limit. Spend is measured from recorded token usage
// (lib/spend.ts), so a harness whose cost the factory cannot read never reaches a limit.

export const DEFAULT_SPEND_LIMIT_USD = 10;

export const money = (usd: number) => `$${usd.toFixed(2)}`;

/** A job the runner paused at its spend limit: it waits on the runner's own budget event. */
export const isSpendPause = (job: Pick<JobRow, "stage" | "stage_event_id">) =>
  job.stage === "waiting" && job.stage_event_id !== null && causeOf(job.stage_event_id) === "budget";

export function pauseQuestion(spent: number, limit: number, increment: number) {
  return [
    `This attempt has spent ${money(spent)}, reaching its ${money(limit)} spend limit, so marshal-factory paused it.`,
    `Reply with a new limit, such as "$${Math.ceil(limit + increment)}", to let it continue. A reply without an amount raises the limit by ${money(increment)}.`,
    "To stop instead, remove the factory label.",
  ].join(" ");
}

const AMOUNT = [/\$\s*(\d+(?:\.\d{1,2})?)/, /\b(\d+(?:\.\d{1,2})?)\s*(?:usd|dollars?)\b/i, /^\s*(\d+(?:\.\d{1,2})?)\s*$/];

/** The dollar amount an answer names: `$20`, `20 USD`, `20 dollars`, or a bare number as the whole answer. */
export function answeredAmount(answer: string): number | null {
  for (const pattern of AMOUNT) {
    const match = pattern.exec(answer);
    if (match) return Number(match[1]);
  }
  return null;
}

/** The limit an answer sets: the amount it names when that is above the spend, else the old limit (or the spend, if higher) plus the increment. */
export function raisedLimit(answer: string, spent: number, limit: number, increment: number) {
  const asked = answeredAmount(answer);
  return asked !== null && asked > spent ? asked : Math.max(limit, spent) + increment;
}

/** The turn a paused thread receives once the owner raised its limit: carry on, not start over. */
export function spendResumeMessage(subject: string, spent: number, limit: number, playbook: string) {
  return [
    `marshal-factory paused your work on ${subject} at its spend limit, after ${money(spent)}. The owner raised the limit to ${money(limit)}.`,
    "",
    `Continue exactly where you stopped, following the factory playbook (${playbook}) on this same branch. First call report_stage with the stage you are in, then go on. Do not start over from Triage.`,
  ].join("\n");
}
