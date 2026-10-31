import type { AuditRow } from "@/db/schema";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { Time } from "./time";

const ACTION: Record<AuditRow["action"], { label: string; tone: string }> = {
  merge_requested: { label: "Merge requested", tone: "text-foreground" },
  merge_succeeded: { label: "Merged", tone: "text-success" },
  merge_failed: { label: "Merge failed", tone: "text-destructive" },
  sandbox_login_failed: { label: "Sandbox login failed", tone: "text-destructive" },
  merge_decided: { label: "Merge decision", tone: "text-foreground" },
  override_fallback: { label: "Ticket override not applied", tone: "text-warning" },
  follow_up_filed: { label: "Follow-up filed", tone: "text-foreground" },
  review_dropped: { label: "Review not forwarded", tone: "text-warning" },
  job_archived: { label: "Archived", tone: "text-foreground" },
  job_unarchived: { label: "Unarchived", tone: "text-foreground" },
  queue_changed: { label: "Queue changed", tone: "text-foreground" },
};

const RESULT: Record<NonNullable<AuditRow["result"]>, string> = {
  ok: "ok",
  head_moved: "head moved",
  not_mergeable: "not mergeable",
  refused: "refused",
  error: "error",
};

/** The job's audit rows, newest first: who asked, when, for which commit, and what came of it. */
export function AuditLog({ rows }: { rows: readonly AuditRow[] }) {
  if (rows.length === 0) return null;
  return (
    <>
      <Separator />
      <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
        <h3 className="text-sm font-medium text-muted-foreground">Audit log</h3>
        <ol className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-0.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={cn("font-medium", ACTION[row.action].tone)}>{ACTION[row.action].label}</span>
                {row.result && row.result !== "ok" && <span className="text-muted-foreground">{RESULT[row.result]}</span>}
                {row.head_sha && <span className="font-mono text-xs text-faint">{row.head_sha.slice(0, 7)}</span>}
                <span className="ml-auto text-xs text-faint">
                  <Time date={row.at} />
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {row.actor}
                {row.detail && ` · ${row.detail}`}
                {row.action === "follow_up_filed" && (
                  <>
                    {" · "}
                    <a href={row.target} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                      Open the issue
                    </a>
                  </>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
