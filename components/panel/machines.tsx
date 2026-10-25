"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import type { MachineRow } from "@/db/schema";
import {
  isOnline,
  parseHeartbeat,
  parseInventory,
  UNKNOWN,
  type Heartbeat,
  type Inventory,
  type Known,
} from "@/lib/machine";
import { useFeed, type Feed } from "./sealed";
import { PanelHeader } from "./panel-header";
import { Time, useNow } from "./time";

const CLOCK_TICK_MS = 30_000;
const GIB = 1024 ** 3;

const gb = (bytes: number) => `${(bytes / GIB).toFixed(bytes >= 100 * GIB ? 0 : 1)} GB`;
const percent = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

const Unknown = () => <span className="text-muted-foreground">unknown</span>;

function whenKnown<T>(value: Known<T> | null | undefined, render: (v: T) => ReactNode) {
  return value === null || value === undefined || value === UNKNOWN ? <Unknown /> : render(value as T);
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

const PROJECT_SOURCE: Record<string, string> = {
  sqlite: "from T3 state",
  probe: "probed with the t3 CLI",
  [UNKNOWN]: "unknown",
};

function Projects({ inventory }: { inventory: Inventory | null }) {
  if (!inventory) return <Unknown />;
  const originByPath = new Map(inventory.repos.map((r) => [r.path, r.origin]));
  const isFactory = (path: string) => (originByPath.has(path) ? 0 : 1);
  const projects =
    inventory.projects.source === UNKNOWN
      ? []
      : [...inventory.projects.items].sort((a, b) => isFactory(a.path) - isFactory(b.path));
  const projectPaths = new Set(projects.map((p) => p.path));
  const unlinkedRepos = inventory.repos.filter((r) => !projectPaths.has(r.path));
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-muted-foreground">
        Projects, {PROJECT_SOURCE[inventory.projects.source]}
      </div>
      <ul className="flex flex-col gap-1.5">
        {projects.map((p) => (
          <li key={p.path} className="flex flex-col">
            <span className="flex flex-wrap items-center gap-1.5">
              {p.title}
              {originByPath.has(p.path) && (
                <>
                  <Badge variant="secondary">factory</Badge>
                  <span className="font-mono text-xs">
                    {whenKnown(originByPath.get(p.path), (origin) => origin)}
                  </span>
                </>
              )}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">{p.path}</span>
          </li>
        ))}
        {unlinkedRepos.map((r) => (
          <li key={r.path} className="flex flex-col">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">factory</Badge>
              <span className="font-mono text-xs">{whenKnown(r.origin, (origin) => origin)}</span>
              <span className="text-xs text-muted-foreground">not a T3 project</span>
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">{r.path}</span>
          </li>
        ))}
        {projects.length === 0 && unlinkedRepos.length === 0 && (
          <li className="text-muted-foreground">none</li>
        )}
      </ul>
    </div>
  );
}

function Resources({ heartbeat }: { heartbeat: Heartbeat | null }) {
  return (
    <>
      <Stat label="CPU">
        {whenKnown(heartbeat?.cpu, (cpu) => (
          <>
            load {cpu.load1.toFixed(2)} / {cpu.cores} cores ({percent(cpu.load1, cpu.cores)})
          </>
        ))}
      </Stat>
      <Stat label="Memory">
        {whenKnown(heartbeat?.memory, (m) => (
          <>
            {gb(m.usedBytes)} / {gb(m.totalBytes)} ({percent(m.usedBytes, m.totalBytes)})
          </>
        ))}
      </Stat>
      <Stat label="Disk free">
        {whenKnown(heartbeat?.disk, (d) => (
          <>
            {gb(d.freeBytes)} / {gb(d.totalBytes)}
          </>
        ))}
      </Stat>
      <Stat label="Capacity">
        {whenKnown(heartbeat?.capacity, (c) => (
          <>
            {c.inFlight} in flight / {c.max} max
          </>
        ))}
      </Stat>
    </>
  );
}

function MachineCard({ machine, now }: { machine: MachineRow; now: number | null }) {
  const heartbeat = parseHeartbeat(machine.heartbeat);
  const inventory = parseInventory(machine.inventory);
  const online = now === null ? null : isOnline(machine.last_seen_at, now);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {machine.name}
          {online !== null && (
            <Badge variant={online ? "default" : "outline"}>{online ? "online" : "offline"}</Badge>
          )}
        </CardTitle>
        <div className="font-mono text-xs text-muted-foreground">{machine.id}</div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="flex flex-col gap-1.5">
          <Stat label="Last seen">
            <Time date={machine.last_seen_at} />
            {now !== null && <span className="text-muted-foreground"> · {ago(now - machine.last_seen_at.getTime())}</span>}
          </Stat>
          <Stat label="T3">
            {whenKnown(inventory?.t3, (t3) => (
              <>
                {t3.up ? "up" : "down"}
                {t3.version && <span className="font-mono text-xs"> {t3.version}</span>}
              </>
            ))}
          </Stat>
          <Stat label="Connect">{inventory ? whenKnown(inventory.connect, (c) => c) : <Unknown />}</Stat>
          <Resources heartbeat={heartbeat} />
          <Stat label="Runner">
            {whenKnown(inventory?.runnerSha, (sha) => (
              <span className="font-mono text-xs">{sha.slice(0, 7)}</span>
            ))}
          </Stat>
        </dl>
        <Projects inventory={inventory} />
      </CardContent>
    </Card>
  );
}

export function Machines({ machines }: { machines: Feed<MachineRow> }) {
  const { rows, status } = useFeed(machines, "/api/live/machines");
  const now = useNow(CLOCK_TICK_MS);
  const onlineMachines =
    now === null ? null : rows.filter((m) => isOnline(m.last_seen_at, now)).length;

  return (
    <>
      <PanelHeader title="Machines" status={status} note={onlineMachines === null ? undefined : `${onlineMachines} online`} />
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {rows.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No machines yet</EmptyTitle>
                <EmptyDescription>
                  A machine appears here as soon as its runner sends its first heartbeat.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
              {rows.map((machine) => (
                <MachineCard key={machine.id} machine={machine} now={now} />
              ))}
            </div>
          )}
      </div>
    </>
  );
}
