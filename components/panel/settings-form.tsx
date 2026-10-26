"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveSettings } from "@/app/actions/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { MachineRow, SettingsRow } from "@/db/schema";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, harnessLabel, isTracked, type Harness } from "@/lib/harness";
import { reportedHarnesses } from "@/lib/machine";
import { useFeed, type Feed } from "./sealed";
import { PanelHeader } from "./panel-header";
import { useAfterHydration, useNow } from "./time";

const CLOCK_TICK_MS = 30_000;

function When({ date }: { date: Date }) {
  const text = useAfterHydration(() => date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }), "");
  return <time dateTime={date.toISOString()}>{text}</time>;
}

const describe = (harnesses: readonly Harness[], provider: string, model: string) => {
  const harness = harnesses.find((h) => h.id === provider);
  return {
    harness: harness?.name ?? harnessLabel(provider),
    model: harness?.models.find((m) => m.slug === model)?.name ?? model,
    tracked: isTracked(harness?.driver ?? provider),
  };
};

function UntrackedWarning({ name }: { name: string }) {
  return (
    <div role="note" className="flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>
        Runs on {name} will not show stages, agents or cost on the board yet. The budget cap and the quiet-run watchdog do not
        apply to them, so check them in T3 directly. The board still shows when a run is queued and launched, and the watchdog
        still fails a run whose thread is gone.
      </p>
    </div>
  );
}

function Current({ saved, harnesses }: { saved: SettingsRow | null; harnesses: readonly Harness[] }) {
  const provider = saved?.provider ?? DEFAULT_PROVIDER;
  const model = saved?.model ?? DEFAULT_MODEL;
  const current = describe(harnesses, provider, model);
  return (
    <div className="flex flex-col gap-1 text-sm">
      <div>
        New threads start on <span className="font-medium">{current.harness}</span> with{" "}
        <span className="font-medium">{current.model}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {" "}
          ({provider} · {model})
        </span>
      </div>
      <div className="text-muted-foreground">
        {saved ? (
          <>
            From saved settings, by {saved.updated_by} on <When date={saved.updated_at} />.
          </>
        ) : (
          <>
            From the runner config default. A runner whose config.json sets <span className="font-mono text-xs">factory.provider</span>{" "}
            and <span className="font-mono text-xs">factory.model</span> uses those until you save settings here.
          </>
        )}
      </div>
    </div>
  );
}

export function SettingsForm({ machines, saved }: { machines: Feed<MachineRow>; saved: SettingsRow | null }) {
  const router = useRouter();
  const { rows, status } = useFeed(machines, "/api/live/machines");
  const now = useNow(CLOCK_TICK_MS);
  const reported = reportedHarnesses(rows, now ?? 0);
  const harnesses = reported?.filter((h) => h.enabled) ?? [];

  const [provider, setProvider] = useState(saved?.provider ?? DEFAULT_PROVIDER);
  const [model, setModel] = useState(saved?.model ?? DEFAULT_MODEL);
  const [failure, setFailure] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);
  const [pending, startTransition] = useTransition();

  const harness = harnesses.find((h) => h.id === provider);
  const modelKnown = harness?.models.some((m) => m.slug === model) ?? false;
  const unchanged = saved !== null && saved.provider === provider && saved.model === model;
  const chosen = describe(harnesses, provider, model);

  const pickHarness = (id: string) => {
    const next = harnesses.find((h) => h.id === id);
    setProvider(id);
    if (!next?.models.some((m) => m.slug === model)) setModel(next?.models[0]?.slug ?? "");
    setSavedNow(false);
  };

  const submit = () => {
    setFailure(null);
    startTransition(async () => {
      const outcome = await saveSettings({ provider, model });
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      setSavedNow(true);
      router.refresh();
    });
  };

  return (
    <>
      <PanelHeader title="Settings" status={status} />
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Harness and model</CardTitle>
            <CardDescription>
              The T3 provider and model every runner starts new factory threads on. Threads already running keep theirs.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <Current saved={saved} harnesses={reported ?? []} />
            {reported === null ? (
              <p className="text-sm text-muted-foreground">
                No machine has reported its harnesses yet. The runner reports them with its inventory, at startup and every
                few minutes; once one has, you can pick a harness here.
              </p>
            ) : (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="settings-harness">Harness</FieldLabel>
                  <Select value={harness ? provider : ""} onValueChange={pickHarness}>
                    <SelectTrigger id="settings-harness" className="w-full">
                      <SelectValue placeholder="Pick a harness" />
                    </SelectTrigger>
                    <SelectContent>
                      {harnesses.map((h) => (
                        <SelectItem key={h.id} value={h.id}>
                          {h.name}
                          {h.name !== h.id && <span className="font-mono text-xs text-muted-foreground">{h.id}</span>}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>The enabled T3 providers your machines report.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="settings-model">Model</FieldLabel>
                  <Select
                    value={modelKnown ? model : ""}
                    onValueChange={(slug) => {
                      setModel(slug);
                      setSavedNow(false);
                    }}
                    disabled={!harness || harness.models.length === 0}
                  >
                    <SelectTrigger id="settings-model" className="w-full">
                      <SelectValue placeholder={harness && harness.models.length === 0 ? "T3 lists no models for this harness" : "Pick a model"} />
                    </SelectTrigger>
                    <SelectContent>
                      {harness?.models.map((m) => (
                        <SelectItem key={m.slug} value={m.slug}>
                          {m.name}
                          {m.name !== m.slug && <span className="font-mono text-xs text-muted-foreground">{m.slug}</span>}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {harness && !chosen.tracked && <UntrackedWarning name={chosen.harness} />}
              </FieldGroup>
            )}
            {failure && (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            )}
          </CardContent>
          {reported !== null && (
            <CardFooter className="gap-3">
              <Button onClick={submit} disabled={pending || !harness || !modelKnown || unchanged}>
                {pending && <Spinner data-icon="inline-start" />}
                Save
              </Button>
              {savedNow && unchanged && <span className="text-sm text-muted-foreground">Saved. The next launch uses it.</span>}
            </CardFooter>
          )}
        </Card>
      </div>
    </>
  );
}
