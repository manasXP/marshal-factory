"use client";

import { CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { saveSettings } from "@/app/actions/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { MachineRow, NotificationSettingsRow, SettingsRow } from "@/db/schema";
import { DEFAULT_EXECUTION, EXECUTIONS, isCloud, type CloudExecution, type Execution } from "@/lib/execution";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, harnessLabel, trackingOf, type Harness, type Tracking } from "@/lib/harness";
import { componentName, IMAGE_COMPONENTS, rebuildText, reportedDrift, reportedHarnesses, reportedSandbox, reportedSlack, sandboxLogin, type SandboxReadiness } from "@/lib/machine";
import { DEFAULT_SPEND_LIMIT_USD } from "@/lib/spend-limit";
import { NotificationsCard } from "./notifications-card";
import { useFeed, type Feed } from "./sealed";
import { PanelFooter, PanelHeader } from "./panel-header";
import { SettingsSection } from "./settings-section";
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
    tracking: trackingOf(harness?.driver ?? provider),
  };
};

function UntrackedWarning({ name, tracking }: { name: string; tracking: Exclude<Tracking, "full"> }) {
  const shows =
    tracking === "stages"
      ? `Runs on ${name} report their stages, questions and pull requests through the factory-report MCP server, and the runner reads their cost from ${name}'s session logs. A run whose usage can't be read, or whose model has no price, has an unknown cost. The quiet-run watchdog does not apply to them.`
      : `Runs on ${name} will not show stages, agents or cost on the board yet. The quiet-run watchdog does not apply to them, so check them in T3 directly.`;
  return (
    <div role="note" className="flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>
        {shows} The board still shows when a run is queued and launched, and the watchdog still fails a run whose thread is gone.
      </p>
    </div>
  );
}

const EXECUTION_LABELS: Record<Execution, string> = { local: "This Mac", modal: "Cloud (Modal)", upstash: "Cloud (Upstash Box)" };

type Check = { tone: "ok" | "warn" | "missing"; label: ReactNode; howTo?: ReactNode };

const Cmd = ({ children }: { children: string }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;

const CHECK_ICON: Record<Check["tone"], ReactNode> = {
  ok: <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" />,
  warn: <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />,
  missing: <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />,
};

const imageSummary = (info: NonNullable<SandboxReadiness["imageInfo"]>) => {
  const versions = { t3: info.t3Version, ...info.versions };
  return IMAGE_COMPONENTS.flatMap((c) => (versions[c] ? [`${componentName(c)} ${versions[c]}`] : [])).join(" · ");
};

/** An outdated image as the runner's own rebuild of it stands: under way, failed, or not started yet. */
function imageRebuild(build: SandboxReadiness["imageBuild"], drift: string, buildImage: ReactNode): Check {
  if (build?.state === "building") {
    return {
      tone: "warn",
      label: (
        <>
          Rebuilding the sandbox image since <When date={new Date(build.startedAt)} />
          <span className="text-muted-foreground"> · {build.reason}. Cloud jobs launch once it lands</span>
        </>
      ),
    };
  }
  if (build?.state === "failed") {
    return {
      tone: "missing",
      label: (
        <>
          The sandbox image rebuild failed <When date={new Date(build.at)} />
          <span className="text-muted-foreground"> · {build.error}</span>
        </>
      ),
      howTo: (
        <>
          The runner tries again in an hour or when a pin changes. To retry now, run <Cmd>bun scripts/sandbox-image.ts</Cmd> on the runner Mac.
        </>
      ),
    };
  }
  return { tone: "missing", label: drift, howTo: <>The runner starts the rebuild on its next tick; to build by hand, {buildImage}</> };
}

function sandboxChecks(readiness: SandboxReadiness, cloud: CloudExecution): Check[] {
  if (cloud === "upstash") return [...upstashChecks(readiness), ...loginChecks(readiness)];
  return [...modalChecks(readiness), ...loginChecks(readiness)];
}

/** Upstash Box's key and base snapshot. The runner never rebuilds the snapshot on its own. */
function upstashChecks(readiness: SandboxReadiness): Check[] {
  const info = readiness.upstashImageInfo ?? null;
  const drift = reportedDrift({ ...readiness, imageInfo: info });
  const build = (
    <>
      run <Cmd>bun scripts/sandbox-image.ts --backend upstash</Cmd> on the runner Mac.
    </>
  );
  return [
    readiness.upstash
      ? { tone: "ok", label: "Upstash Box API key present" }
      : {
          tone: "missing",
          label: "No Upstash Box API key on the runner",
          howTo: (
            <>
              Create a key in the Upstash Console, add it as <Cmd>UPSTASH_BOX_API_KEY</Cmd> to the runner checkout&apos;s <Cmd>.env.local</Cmd> and restart the
              runner.
            </>
          ),
        },
    !info
      ? { tone: "missing", label: "No Upstash base snapshot built", howTo: <>For the first build, {build}</> }
      : drift.length > 0
        ? { tone: "missing", label: rebuildText(drift, "the Upstash base snapshot"), howTo: <>To rebuild, {build}</> }
        : {
            tone: "ok",
            label: (
              <>
                Upstash base snapshot built <When date={new Date(info.builtAt)} />
                <span className="text-muted-foreground"> · {imageSummary(info)}</span>
              </>
            ),
          },
  ];
}

function modalChecks(readiness: SandboxReadiness): Check[] {
  const { imageInfo } = readiness;
  const drift = reportedDrift(readiness);
  const buildImage = (
    <>
      run <Cmd>bun scripts/sandbox-image.ts</Cmd> on the runner Mac.
    </>
  );
  return [
    readiness.modal
      ? { tone: "ok", label: "Cloud sandbox token present" }
      : {
          tone: "missing",
          label: "No cloud sandbox token on the runner",
          howTo: (
            <>
              Run <Cmd>uv tool install modal</Cmd> and then <Cmd>modal token new</Cmd> on the runner Mac.
            </>
          ),
        },
    !readiness.image
      ? { tone: "missing", label: "No sandbox image built", howTo: <>For the first build, {buildImage}</> }
      : drift.length > 0
        ? imageRebuild(readiness.imageBuild, rebuildText(drift), buildImage)
        : {
            tone: "ok",
            label: imageInfo ? (
              <>
                Sandbox image built <When date={new Date(imageInfo.builtAt)} />
                <span className="text-muted-foreground">
                  {" "}
                  · {imageSummary(imageInfo)} · factory <span className="font-mono text-xs">{imageInfo.factoryCommit.slice(0, 7)}</span>
                </span>
              </>
            ) : (
              "Sandbox image built"
            ),
          },
  ];
}

/** The logins every cloud's jobs run with. */
function loginChecks(readiness: SandboxReadiness): Check[] {
  const unusable = readiness.codexSlotsUnusable ?? 0;
  return [
    readiness.claude
      ? { tone: "ok", label: "Claude token present" }
      : {
          tone: "warn",
          label: "No Claude token: Claude Code jobs will run on Codex",
          howTo: (
            <>
              Run <Cmd>claude setup-token</Cmd>, add the token as <Cmd>CLAUDE_CODE_OAUTH_TOKEN</Cmd> to the runner checkout&apos;s{" "}
              <Cmd>.env.local</Cmd> and restart the runner.
            </>
          ),
        },
    {
      tone: !sandboxLogin(readiness) ? "missing" : readiness.codexSlots === 0 || unusable > 0 ? "warn" : "ok",
      label: `Codex logins: ${readiness.codexSlots} usable${unusable > 0 ? `, ${unusable} unusable` : ""}${readiness.codexSlots === 0 && readiness.claude ? ". Codex jobs wait for one; Claude Code jobs need none" : ""}`,
      howTo:
        readiness.codexSlots === 0 || unusable > 0 ? (
          <>
            {unusable > 0 && "Log in again in an unusable slot to clear it. "}
            Run <Cmd>{`mkdir -p ~/.codex-factory-${readiness.codexSlots + unusable + 1} && CODEX_HOME=~/.codex-factory-${readiness.codexSlots + unusable + 1} codex login --device-auth`}</Cmd>{" "}
            to add a login, and list its folder in <Cmd>factory.sandbox.codexSlots</Cmd> in the runner&apos;s config.json.
          </>
        ) : undefined,
    },
  ];
}

/** What the runner reports about its Modal setup: booleans, counts and the image's version, never a credential. */
function SandboxReadinessList({ readiness, cloud }: { readiness: SandboxReadiness | null; cloud: CloudExecution }) {
  if (!readiness) {
    return (
      <div role="note" className="flex gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
        <p>No online runner reports its cloud sandbox setup yet. Jobs stay queued until one is ready.</p>
      </div>
    );
  }
  const checks = sandboxChecks(readiness, cloud);
  const blocked = checks.some((c) => c.tone === "missing");
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 text-sm">
      <p className={blocked ? "text-warning" : "text-muted-foreground"}>
        {blocked ? "Cloud sandboxes are not ready yet. Jobs stay queued until they are." : "Cloud sandboxes are ready on the runner."}
      </p>
      <ul className="flex flex-col gap-2.5">
        {checks.map((check, i) => (
          <li key={i} className="flex gap-2.5">
            {CHECK_ICON[check.tone]}
            <div className="flex min-w-0 flex-col gap-0.5">
              <span>{check.label}</span>
              {check.howTo && <span className="text-muted-foreground">{check.howTo}</span>}
            </div>
          </li>
        ))}
      </ul>
      {readiness.maxParallel !== undefined && (
        <p className="text-muted-foreground">
          The runner runs at most {readiness.maxParallel} sandboxes at once (<Cmd>factory.sandbox.maxParallel</Cmd>), and every
          job also counts against <Cmd>factory.maxInFlight</Cmd>. Both are set in the runner&apos;s config.json.
        </p>
      )}
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
        <span className="font-medium">{current.model}</span>, on{" "}
        <span className="font-medium">{EXECUTION_LABELS[saved?.execution ?? DEFAULT_EXECUTION]}</span>
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

export function SettingsForm({ machines, saved, notifications }: { machines: Feed<MachineRow>; saved: SettingsRow | null; notifications: NotificationSettingsRow | null }) {
  const router = useRouter();
  const { rows, status } = useFeed(machines, "/api/live/machines");
  const now = useNow(CLOCK_TICK_MS);
  const reported = reportedHarnesses(rows, now ?? 0);
  const harnesses = reported?.filter((h) => h.enabled) ?? [];
  const readiness = reportedSandbox(rows, now ?? 0);
  const slack = now === null ? null : reportedSlack(rows, now);

  const [provider, setProvider] = useState(saved?.provider ?? DEFAULT_PROVIDER);
  const [model, setModel] = useState(saved?.model ?? DEFAULT_MODEL);
  const [execution, setExecution] = useState<Execution>(saved?.execution ?? DEFAULT_EXECUTION);
  const [spendLimit, setSpendLimit] = useState(String(saved?.spend_limit_usd ?? DEFAULT_SPEND_LIMIT_USD));
  const [failure, setFailure] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);
  const [pending, startTransition] = useTransition();

  const harness = harnesses.find((h) => h.id === provider);
  const modelKnown = harness?.models.some((m) => m.slug === model) ?? false;
  const unchanged =
    saved !== null && saved.provider === provider && saved.model === model && saved.execution === execution && saved.spend_limit_usd === Number(spendLimit);
  const chosen = describe(harnesses, provider, model);

  const pickHarness = (id: string | null) => {
    if (id === null) return;
    const next = harnesses.find((h) => h.id === id);
    setProvider(id);
    if (!next?.models.some((m) => m.slug === model)) setModel(next?.models[0]?.slug ?? "");
    setSavedNow(false);
  };

  const submit = () => {
    setFailure(null);
    startTransition(async () => {
      const outcome = await saveSettings({ provider, model, execution, spendLimitUsd: spendLimit });
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
      <PanelHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col divide-y p-4 md:p-8">
          <SettingsSection
            id="new-jobs"
            title="New jobs"
            description={
              <>
                The T3 harness and model every runner starts new factory threads on, and where they run. Threads already running keep theirs. A
                repository can override these, and sets how far the factory merges, on{" "}
                <Link href="/repositories" className="underline underline-offset-2">
                  Repositories
                </Link>
                .
              </>
            }
          >
            <Card>
              <CardContent className="flex flex-col gap-6">
                <Current saved={saved} harnesses={reported ?? []} />
                {reported === null ? (
                  <p className="text-sm text-muted-foreground">
                    No machine has reported its harnesses yet. The runner reports them with its inventory, at startup and every
                    few minutes; once one has, you can pick a harness here.
                  </p>
                ) : (
                  <div className="flex flex-col gap-5">
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor="settings-harness">Harness</FieldLabel>
                        <Select
                          items={harnesses.map((h) => ({ value: h.id, label: h.name }))}
                          value={harness ? provider : null}
                          onValueChange={pickHarness}
                        >
                          <SelectTrigger id="settings-harness" className="w-full">
                            <SelectValue placeholder="Pick a harness" />
                          </SelectTrigger>
                          <SelectPopup>
                            {harnesses.map((h) => (
                              <SelectItem key={h.id} value={h.id}>
                                {h.name}
                                {h.name !== h.id && <span className="font-mono text-xs text-muted-foreground">{h.id}</span>}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                        <FieldDescription>The enabled T3 providers your machines report.</FieldDescription>
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="settings-model">Model</FieldLabel>
                        <Select
                          items={harness?.models.map((m) => ({ value: m.slug, label: m.name })) ?? []}
                          value={modelKnown ? model : null}
                          onValueChange={(slug) => {
                            if (slug === null) return;
                            setModel(slug);
                            setSavedNow(false);
                          }}
                          disabled={!harness || harness.models.length === 0}
                        >
                          <SelectTrigger id="settings-model" className="w-full">
                            <SelectValue placeholder={harness && harness.models.length === 0 ? "T3 lists no models for this harness" : "Pick a model"} />
                          </SelectTrigger>
                          <SelectPopup>
                            {harness?.models.map((m) => (
                              <SelectItem key={m.slug} value={m.slug}>
                                {m.name}
                                {m.name !== m.slug && <span className="font-mono text-xs text-muted-foreground">{m.slug}</span>}
                              </SelectItem>
                            ))}
                          </SelectPopup>
                        </Select>
                      </Field>
                    </div>
                    {harness && chosen.tracking !== "full" && <UntrackedWarning name={chosen.harness} tracking={chosen.tracking} />}
                    <Field className="sm:max-w-[calc(50%-0.625rem)]">
                      <FieldLabel htmlFor="settings-execution">Run jobs on</FieldLabel>
                      <Select
                        items={EXECUTIONS.map((e) => ({ value: e, label: EXECUTION_LABELS[e] }))}
                        value={execution}
                        onValueChange={(value) => {
                          if (value === null) return;
                          setExecution(value);
                          setSavedNow(false);
                        }}
                      >
                        <SelectTrigger id="settings-execution" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          {EXECUTIONS.map((e) => (
                            <SelectItem key={e} value={e}>
                              {EXECUTION_LABELS[e]}
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                      <FieldDescription>Cloud runs each job in its own cloud sandbox; this Mac runs it in the runner&apos;s T3.</FieldDescription>
                    </Field>
                    {isCloud(execution) && <SandboxReadinessList readiness={readiness} cloud={execution} />}
                    <Field className="sm:max-w-[calc(50%-0.625rem)]">
                      <FieldLabel htmlFor="settings-spend-limit">Spend limit per attempt (USD)</FieldLabel>
                      <Input
                        id="settings-spend-limit"
                        type="number"
                        inputMode="decimal"
                        min={1}
                        step={1}
                        value={spendLimit}
                        onChange={(e) => {
                          setSpendLimit(e.target.value);
                          setSavedNow(false);
                        }}
                      />
                      <FieldDescription>
                        An attempt that spends this much pauses and asks on its issue for a higher limit. A reply without an amount raises it by this much again. New attempts get the new limit.
                      </FieldDescription>
                    </Field>
                  </div>
                )}
                {failure && (
                  <p role="alert" className="text-sm text-destructive">
                    {failure}
                  </p>
                )}
              </CardContent>
              {reported !== null && (
                <CardFooter className="gap-3 border-t">
                  <Button onClick={submit} disabled={pending || !harness || !modelKnown || unchanged}>
                    {pending && <Spinner data-icon="inline-start" />}
                    Save
                  </Button>
                  {savedNow && unchanged && <span className="text-sm text-muted-foreground">Saved. The next launch uses it.</span>}
                </CardFooter>
              )}
            </Card>
          </SettingsSection>
          <NotificationsCard saved={notifications} slack={slack} />
        </div>
      </div>
      <PanelFooter status={status} />
    </>
  );
}
