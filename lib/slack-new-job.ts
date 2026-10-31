import { z } from "zod";
import { EXECUTIONS } from "@/lib/execution";
import type { Harness } from "@/lib/harness";
import { createJob } from "@/lib/new-job";
import { newJobSchema, type NewJob } from "@/lib/new-job-schema";
import { displayName } from "@/lib/repo-name";
import { defaultRepo, type Registry } from "@/lib/repositories";
import { SLACK_COMMAND, SLACK_SHORTCUT_CALLBACK_ID, type SlackMessage } from "@/lib/slack";
import type { InteractionDeps } from "@/lib/slack-interactions";
import { ephemeral, invalidSignature, NO_TOKEN, NOT_OWNER, parseJson, safeMessage, signedBody, uuidFrom } from "@/lib/slack-request";
import { RUNS_ON_LABELS } from "@/lib/ticket-overrides";

// Filing jobs from Slack: `/factory` (app/api/slack/commands) and the "Send to factory" message
// shortcut (app/api/slack/interactions) open the panel's New job form as a modal, and submitting it
// files the job through the panel's own createJob (lib/new-job.ts) as the owner. Slack is one more
// front door to the same source: the issue it files is claimed like any other.

export const NEW_JOB_CALLBACK_ID = "factory:new_job";

/** The modal's inputs; each element's action id is VALUE. */
export const NEW_JOB_BLOCKS = { title: "title", description: "description", repo: "repo", harness: "harness", runsOn: "runs_on" } as const;
const VALUE = "value";
/** The select option that adds no override label, as the panel's "Settings default". */
export const SETTINGS_DEFAULT = "settings-default";
/** Slack's limits: a plain text input's length, a select option's text. */
const SLACK_INPUT_MAX = 3000;
const OPTION_TEXT_MAX = 75;
const TITLE_MAX = 80;
/** The form fills in without the link rather than sit on its loading view. */
const PERMALINK_TIMEOUT_MS = 1_000;

export const USAGE = [
  "`/factory` opens the New job form.",
  "`/factory <what to build>` opens it with that as the title and description.",
  "*Send to factory* in a message's ⋯ menu files that message, with a link back to it.",
  "`/factory help` shows this.",
].join("\n");

export const newJobRequestId = (viewId: string) => uuidFrom(`slack:new_job:${viewId}`);

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const decodeEntities = (text: string) => text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** Slack's message markup as plain text: links, mentions and channels by their labels, entities decoded. */
export function fromSlack(text: string) {
  return decodeEntities(
    text.replace(/<([^<>]+)>/g, (_, inner: string) => {
      const [target = "", label] = inner.split("|", 2);
      if (target.startsWith("@") || target.startsWith("#")) return `${target[0]}${label ?? target.slice(1)}`;
      if (target.startsWith("!")) return label ?? `@${target.slice(1)}`;
      return label && label !== target ? `${label} (${target})` : target;
    }),
  );
}

/** A short title from text: its first non-empty line. */
export const titleFrom = (text: string) => clip((text.split("\n").find((line) => line.trim()) ?? "").replace(/\s+/g, " ").trim(), TITLE_MAX);

export type Prefill = { title: string; description: string };

/** The manifest turns off should_escape for /factory, so its text has no link markup to read. */
export function commandPrefill(text: string): Prefill {
  const plain = decodeEntities(text).trim();
  const title = titleFrom(plain);
  return { title, description: plain === title ? "" : clip(plain, SLACK_INPUT_MAX) };
}

export function shortcutPrefill(text: string, permalink: string | null): Prefill {
  const plain = fromSlack(text).trim();
  const source = permalink ? `\n\nFrom Slack: ${permalink}` : "";
  return { title: titleFrom(plain), description: `${clip(plain, SLACK_INPUT_MAX - source.length)}${source}`.trim() };
}

const metaSchema = z.object({ responseUrl: z.string().optional(), channel: z.string().optional(), threadTs: z.string().optional() });
type Meta = z.infer<typeof metaSchema>;

export type ModalOptions = { registry: Registry; harnesses: readonly Harness[] };

/** The repositories and harnesses the panel's form offers. */
async function modalOptions(deps: InteractionDeps): Promise<ModalOptions> {
  const [registry, harnesses] = await Promise.all([deps.inbox.newJob.registry(), deps.inbox.newJob.harnesses()]);
  return { registry, harnesses: (harnesses ?? []).filter((h) => h.enabled) };
}

const plain = (text: string) => ({ type: "plain_text", text });

/**
 * The New job modal with only a note and no submit. The trigger id is good for 3 seconds, so this
 * opens before anything is read; updateView then swaps in the form, which keeps the view's id.
 */
export function newJobNote(text: string) {
  return { type: "modal", callback_id: NEW_JOB_CALLBACK_ID, title: plain("New job"), close: plain("Close"), blocks: [{ type: "section", text: plain(text) }] };
}
export const LOADING = "Loading…";

type OpenedView = { id: string; hash?: string };

/** Fills the opened view in with the form; on an error the view says so, redacted, and the error is rethrown. */
async function fillIn(deps: InteractionDeps, slack: NonNullable<InteractionDeps["slack"]>, view: OpenedView, render: () => Promise<object>) {
  try {
    await slack.updateView(view.id, await render(), view.hash);
  } catch (error) {
    await slack.updateView(view.id, newJobNote(safeMessage(deps.secrets, error))).catch(() => undefined);
    throw error;
  }
}

/** The panel's New job form: title, description, repository, harness and runs on, the defaults preselected. */
export function renderNewJobModal(prefill: Prefill, options: ModalOptions, meta: Meta) {
  const option = (value: string, text: string) => ({ text: plain(clip(text, OPTION_TEXT_MAX)), value });
  const settingsDefault = option(SETTINGS_DEFAULT, "Settings default");
  const repos = options.registry.filter((r) => r.enabled).map((r) => option(r.repo, displayName(r)));
  const initialRepo = repos.find((o) => o.value === defaultRepo(options.registry)?.repo);
  const select = (block: string, label: string, choices: ReturnType<typeof option>[], initial: ReturnType<typeof option> | undefined, hint?: string) => ({
    type: "input",
    block_id: block,
    label: plain(label),
    ...(hint && { hint: plain(hint) }),
    element: { type: "static_select", action_id: VALUE, options: choices, ...(initial && { initial_option: initial }) },
  });
  return {
    type: "modal",
    callback_id: NEW_JOB_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: plain("New job"),
    submit: plain("File job"),
    close: plain("Cancel"),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Files an issue with the factory label. Questions and answers then happen on that issue." },
      },
      {
        type: "input",
        block_id: NEW_JOB_BLOCKS.title,
        label: plain("Title"),
        element: { type: "plain_text_input", action_id: VALUE, max_length: 200, ...(prefill.title && { initial_value: prefill.title }) },
      },
      {
        type: "input",
        block_id: NEW_JOB_BLOCKS.description,
        optional: true,
        label: plain("Description"),
        hint: plain("The agent reads this as the spec. Markdown works."),
        element: { type: "plain_text_input", action_id: VALUE, multiline: true, max_length: SLACK_INPUT_MAX, ...(prefill.description && { initial_value: prefill.description }) },
      },
      ...(repos.length > 0 ? [select(NEW_JOB_BLOCKS.repo, "Repository", repos, initialRepo, "Goes on the issue as its Repository label, the default one included.")] : []),
      select(NEW_JOB_BLOCKS.harness, "Harness", [settingsDefault, ...options.harnesses.map((h) => option(h.id, h.name))], settingsDefault),
      select(NEW_JOB_BLOCKS.runsOn, "Runs on", [settingsDefault, ...EXECUTIONS.map((e) => option(e, RUNS_ON_LABELS[e]))], settingsDefault),
    ],
  };
}

const ack = () => new Response(null, { status: 200 });

const commandSchema = z.object({
  command: z.string(),
  text: z.string().default(""),
  user_id: z.string(),
  trigger_id: z.string(),
  response_url: z.string(),
});

/** `/factory`: help, or the New job modal, empty or prefilled with the text. Only the owner gets the modal. */
export async function handleCommand(request: Request, deps: InteractionDeps): Promise<Response> {
  const body = await signedBody(request, deps.signingSecret, deps.now?.() ?? Date.now());
  if (body === null) return invalidSignature();
  const say = (text: string) => Response.json(ephemeral(deps.secrets, text));
  const command = commandSchema.safeParse(Object.fromEntries(new URLSearchParams(body)));
  if (!command.success || command.data.command !== SLACK_COMMAND) return say(USAGE);
  const { user_id, text, trigger_id, response_url } = command.data;
  if (!deps.ownerSlackId || user_id !== deps.ownerSlackId) return say(NOT_OWNER);
  if (text.trim().toLowerCase() === "help") return say(USAGE);
  const slack = deps.slack;
  if (!slack) return say(NO_TOKEN);
  let view: OpenedView;
  try {
    view = await slack.openView(trigger_id, newJobNote(LOADING));
  } catch (error) {
    return say(safeMessage(deps.secrets, error));
  }
  deps.after(async () => {
    try {
      await fillIn(deps, slack, view, async () => renderNewJobModal(commandPrefill(text), await modalOptions(deps), { responseUrl: response_url }));
    } catch (error) {
      await deps.respond(response_url, ephemeral(deps.secrets, safeMessage(deps.secrets, error))).catch(() => undefined);
    }
  });
  return ack();
}

export const shortcutSchema = z.object({
  type: z.literal("message_action"),
  callback_id: z.literal(SLACK_SHORTCUT_CALLBACK_ID),
  user: z.object({ id: z.string() }),
  trigger_id: z.string(),
  response_url: z.string(),
  channel: z.object({ id: z.string() }),
  message: z.object({ ts: z.string(), text: z.string().default(""), thread_ts: z.string().optional() }),
});

/** "Send to factory" on a message: the New job modal with the message and a link back to it. */
export async function sendToFactory(deps: InteractionDeps, payload: z.infer<typeof shortcutSchema>, owner: boolean) {
  const reply = (text: string) => deps.respond(payload.response_url, ephemeral(deps.secrets, text));
  const slack = owner ? deps.slack : null;
  let view: OpenedView | null = null;
  let openError: unknown = null;
  if (slack) {
    try {
      view = await slack.openView(payload.trigger_id, newJobNote(LOADING));
    } catch (error) {
      openError = error;
    }
  }
  deps.after(async () => {
    try {
      if (!owner) return await reply(NOT_OWNER);
      if (!slack || !view) return await reply(openError ? safeMessage(deps.secrets, openError) : NO_TOKEN);
      const { channel, message } = payload;
      await fillIn(deps, slack, view, async () => {
        const [link, options] = await Promise.all([slack.permalink(channel.id, message.ts, PERMALINK_TIMEOUT_MS).catch(() => null), modalOptions(deps)]);
        const meta: Meta = { responseUrl: payload.response_url, channel: channel.id, threadTs: message.thread_ts ?? message.ts };
        return renderNewJobModal(shortcutPrefill(message.text, link), options, meta);
      });
    } catch (error) {
      await reply(safeMessage(deps.secrets, error)).catch(() => undefined);
    }
  });
  return ack();
}

const stateSchema = z.record(z.string(), z.record(z.string(), z.object({ value: z.string().nullish(), selected_option: z.object({ value: z.string() }).nullish() })));
const submissionSchema = z.object({ view: z.object({ id: z.string(), private_metadata: z.string(), state: z.object({ values: stateSchema }) }) });

/** The job a submission asks for, with a request id from the modal, so submitting it again files the same issue. */
export function newJobInput(viewId: string, values: z.infer<typeof stateSchema>) {
  const input = (block: string) => values[block]?.[VALUE];
  const pick = (block: string) => {
    const value = input(block)?.selected_option?.value;
    return value && value !== SETTINGS_DEFAULT ? value : undefined;
  };
  return {
    title: input(NEW_JOB_BLOCKS.title)?.value ?? "",
    description: input(NEW_JOB_BLOCKS.description)?.value ?? "",
    requestId: newJobRequestId(viewId),
    repo: pick(NEW_JOB_BLOCKS.repo),
    provider: pick(NEW_JOB_BLOCKS.harness),
    execution: pick(NEW_JOB_BLOCKS.runsOn),
  };
}

/** Which input a schema issue belongs under. */
const BLOCK_OF: Record<keyof NewJob, string> = {
  title: NEW_JOB_BLOCKS.title,
  description: NEW_JOB_BLOCKS.description,
  requestId: NEW_JOB_BLOCKS.title,
  repo: NEW_JOB_BLOCKS.repo,
  provider: NEW_JOB_BLOCKS.harness,
  execution: NEW_JOB_BLOCKS.runsOn,
  source: NEW_JOB_BLOCKS.title,
};

/** The New job modal's submission: an invalid form is refused inline, a valid one closes and is filed after the ack. */
export function newJobSubmitted(deps: InteractionDeps, payload: unknown, owner: boolean) {
  const refuse = (block: string, message: string) => Response.json({ response_action: "errors", errors: { [block]: message } });
  if (!owner) return refuse(NEW_JOB_BLOCKS.title, NOT_OWNER);
  const parsed = submissionSchema.safeParse(payload);
  const meta = metaSchema.safeParse(parseJson(parsed.data?.view.private_metadata ?? ""));
  if (!parsed.success || !meta.success) return refuse(NEW_JOB_BLOCKS.title, "This form can't be read; open it again.");
  const valid = newJobSchema.safeParse(newJobInput(parsed.data.view.id, parsed.data.view.state.values));
  if (!valid.success) {
    const issue = valid.error.issues[0];
    return refuse(BLOCK_OF[issue?.path[0] as keyof NewJob] ?? NEW_JOB_BLOCKS.title, issue?.message ?? "The job is not valid.");
  }
  deps.after(() => fileJob(deps, valid.data, meta.data));
  return ack();
}

const message = (text: string): SlackMessage => ({ text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });

/** Tells the owner how it went: an ephemeral note where the form was opened, else a DM. Never throws. */
async function notify(deps: InteractionDeps, meta: Meta, text: string) {
  try {
    if (meta.responseUrl) return await deps.respond(meta.responseUrl, ephemeral(deps.secrets, text));
  } catch (error) {
    console.error(`slack: new job reply failed: ${safeMessage(deps.secrets, error)}`);
  }
  try {
    if (deps.slack && deps.ownerSlackId) await deps.slack.postMessage(await deps.slack.openDm(deps.ownerSlackId), message(ephemeral(deps.secrets, text).text));
  } catch (error) {
    console.error(`slack: new job DM failed: ${safeMessage(deps.secrets, error)}`);
  }
}

/** Files the job through the panel's createJob, confirms it to the owner and, for a shortcut, answers in the message's thread. */
async function fileJob(deps: InteractionDeps, input: NewJob, meta: Meta) {
  let outcome: Awaited<ReturnType<typeof createJob>>;
  try {
    outcome = await createJob(deps.inbox.newJob, input);
  } catch (error) {
    return notify(deps, meta, safeMessage(deps.secrets, error));
  }
  if (!outcome.ok) return notify(deps, meta, outcome.message);
  const { identifier, url } = outcome;
  await notify(deps, meta, `Filed *${escape(identifier)}* · ${escape(input.title)}\nThe factory picks it up within a few seconds. <${url}|Open the issue> · <${deps.panelUrl}/|Open the board>`);
  if (!meta.channel || !meta.threadTs || !deps.slack) return;
  try {
    await deps.slack.postMessage(meta.channel, message(`Filed as <${url}|${escape(identifier)}>`), meta.threadTs);
  } catch (error) {
    console.error(`slack: thread reply for ${identifier} failed: ${safeMessage(deps.secrets, error)}`);
  }
}
