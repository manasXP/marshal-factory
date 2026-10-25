import type { AgentRow, MachineRow, RunRow } from "@/db/schema";
import { cn } from "@/lib/utils";
import { STAGES } from "@/lib/events";
import type { BoardCard } from "./cards";
import { StageCard } from "./run-card";
import { STAGE_META } from "./stages";

export function Board({
  cards,
  agentsBySession,
  selected,
  machines,
}: {
  cards: readonly BoardCard[];
  agentsBySession: Map<string, AgentRow[]>;
  selected: string | undefined;
  machines: ReadonlyMap<string, MachineRow>;
}) {
  const agentsOf = (runs: readonly RunRow[]) =>
    runs.flatMap((r) => agentsBySession.get(r.session_id) ?? []);
  const columns = STAGES.filter(
    (stage) => stage !== "failed" || cards.some((c) => c.stage === "failed"),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
      <section className="flex items-start gap-4 overflow-x-auto pb-2">
        {columns.map((stage) => {
          const items = cards.filter((c) => c.stage === stage);
          return (
            <div
              key={stage}
              data-stage={stage}
              // An empty stage keeps only its header, so the stages with work stay in view.
              className={cn("flex shrink-0 flex-col gap-2", items.length > 0 ? "w-84" : "w-36")}
            >
              <div className="flex items-center gap-2 px-1 py-1 text-sm font-medium">
                <span className={`size-2 rounded-full ${STAGE_META[stage].dot}`} />
                {STAGE_META[stage].label}
                <span className="text-muted-foreground">{items.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {items.length === 0 && <p className="px-1 text-xs text-faint">None</p>}
                {items.map((card) => (
                  <StageCard
                    key={card.id}
                    card={card}
                    machineName={card.machineId && (machines.get(card.machineId)?.name ?? card.machineId)}
                    agents={agentsOf(card.runs)}
                    selected={card.runs.some((r) => r.session_id === selected)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
