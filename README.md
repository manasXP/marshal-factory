# marshal-factory

A software factory that turns Linear issues into pull requests while you watch.

You label an issue in Linear, or file one from the panel. A runner on your Mac picks it up within seconds and starts a [T3 Code](https://github.com/pingdotgg/t3code) thread for it on its own branch, `factory/<issue>`. That thread runs Claude Code with PStack and works the issue on its own: triage, investigation, implementation, verification, and a pull request. Every stage, subagent, model and dollar spent streams live to a web panel. When the agent needs a decision, it asks on the Linear issue and continues once you reply. It never merges. You review the PR and merge it from the panel or from GitHub.

```
Linear / GitHub webhooks ──► Neon Function ──► intents (Postgres)
                                                    │ Realtime
runner daemon on your Mac ◄─────────────────────────┘
  └─ one T3 thread per issue, branch factory/FAC-123
        (Claude Code + PStack + the factory playbook)
              ├─ hooks ───────────┐  sessions, subagents, models, tokens
              └─ factory_report ──┤  stage, status, summary
                                  ▼
                 Neon (ingest Function + Postgres + Realtime)
                                  ▼
            panel on Vercel: board · run timeline · agents · machines
```

The pieces:

- **Panel** (`app/`, `components/`): a Next.js app on Vercel. It shows the board and each run's timeline and cost, and lets you file jobs and merge PRs. Only the owner can sign in.
- **Ingest Function** (`functions/ingest/`): a Neon Function that receives the Linear and GitHub webhooks and the reporter's events, and writes them to Postgres.
- **Runner** (`runner/`): a Bun daemon on your Mac, run by launchd. It is the only part that touches T3, git and the GitHub API.
- **Reporter** (`hooks/`, `mcp/`): Claude Code hooks and a small MCP server, installed into each target repo. They send the run's progress to the ingest Function.
- **Playbook** (`playbooks/factory.md`): the instructions every factory thread follows. It extends PStack's bug-fix and feature playbooks.

## What you need

Accounts:

- **Linear**, with a team for factory work and a personal API key.
- **GitHub**, for the target repo and a GitHub App the setup creates for you.
- **Neon**, for Postgres, Auth, Realtime and the ingest Function.
- **Vercel**, for the panel.

On the Mac that runs the factory:

- macOS. The runner installs as a launchd agent and identifies the Mac by its hardware UUID.
- [Bun](https://bun.sh), git, and the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`). Threads push branches and open PRs with your own git and `gh` credentials.
- Claude Code with the PStack plugin installed.
- T3 Code, running, with its `t3` command line tool. The installer looks for it at `~/.t3/bin/t3`, then on your `PATH`, or you can set `T3CODE_CLI_PATH`.
- The `neon` CLI, signed in, and the `vercel` CLI.
- `jq` and `openssl`, used by a few commands below.

## Install

These steps set up one factory: one Neon project, one panel, and one Mac running the runner. Do them in order. Several steps depend on values an earlier step creates.

### 1. Clone the factory

```sh
git clone https://github.com/<you>/marshal-factory.git ~/code/marshal-factory
cd ~/code/marshal-factory
bun install
```

Fork the repo first if you want Vercel to deploy your copy. This checkout is the **live checkout**. The runner, and the hooks installed into your target repos, run code straight from this path. Keep it on `main` and don't move it. Do development work in a separate clone or worktree.

### 2. Change the two values tied to the original setup

- `scripts/setup-github-app.ts`: change the manifest's `name` (`marshal-factory-ski043`) and `url`. GitHub App names are unique across GitHub, so you need your own, such as `marshal-factory-<you>`.
- `lib/migrate-guard.ts`: `PRODUCTION_ENDPOINTS` names the production database endpoint, so a preview build can never migrate production. You fill it in at step 4.

### 3. Prepare Linear

In the Linear team you want the factory to work in:

- Note the team key, the prefix of its issue ids. The defaults assume `FAC`.
- Make sure the team has the workflow states **Todo**, **In Progress**, **In Review** and **Done**. The factory moves issues between them by name.
- Create a label named `factory`. Only issues with this label in an unstarted state (such as Todo) are picked up.
- Create a personal API key under Settings → Security & access.

If your team key or label differs, set them in every place listed under [Settings](#settings).

### 4. Create the Neon backend

Create a project, link this checkout to it, and turn on Realtime for `main`:

```sh
neon projects create --name marshal-factory
neon init --no-agent-setup      # links this directory to the project; writes .neon
neon realtime enable --branch main --allowed-origin '*'
```

Create `.env.local` with the secrets you choose yourself:

```sh
cat > .env.local <<EOF
FACTORY_INGEST_SECRET=$(openssl rand -hex 32)
LINEAR_WEBHOOK_SECRET=$(openssl rand -hex 32)
NEON_AUTH_COOKIE_SECRET=$(openssl rand -base64 32)
FACTORY_OWNER_EMAILS=you@example.com
LINEAR_API_KEY=<your Linear API key>
FACTORY_TEAM_KEY=FAC
FACTORY_LABEL=factory
EOF
chmod 600 .env.local
```

Deploy `neon.ts` to `main`, which turns on Neon Auth and deploys the ingest Function. The GitHub App doesn't exist yet, so pass a placeholder for its webhook secret. Step 6 replaces it.

```sh
GITHUB_APP_WEBHOOK_SECRET=pending neon deploy --branch main --env .env.local --no-env-pull
```

Pull the values Neon generated (connection strings, Auth, Realtime, and the Function's URL), then create the tables:

```sh
neon env pull --branch main
echo "NEXT_PUBLIC_NEON_REALTIME_URL=$(grep '^NEON_REALTIME_URL=' .env.local | cut -d= -f2-)" >> .env.local
bun run db:migrate
```

`.env.local` now also holds `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_AUTH_BASE_URL`, `NEON_REALTIME_URL`, `NEON_REALTIME_SECRET` and `NEON_FUNCTION_INGEST_BASE_URL`.

Finally, put the production endpoint id into `PRODUCTION_ENDPOINTS` in `lib/migrate-guard.ts`. It is the `ep-…` part of the host in `DATABASE_URL`, without `-pooler`.

### 5. Write the runner's config

The runner and the reporter read `~/.config/marshal-factory/config.json`:

```sh
mkdir -p ~/.config/marshal-factory
set -a; source .env.local; set +a
jq -n --arg key "$LINEAR_API_KEY" --arg url "$NEON_FUNCTION_INGEST_BASE_URL/ingest" --arg secret "$FACTORY_INGEST_SECRET" \
  '{linearApiKey: $key, ingestUrl: $url, secret: $secret, factory: {teamKey: "FAC", label: "factory"}}' \
  > ~/.config/marshal-factory/config.json
chmod 600 ~/.config/marshal-factory/config.json
```

`secret` must equal `FACTORY_INGEST_SECRET`, or ingest rejects the reporter's events. [Settings](#settings) lists the optional limits you can add under `factory`.

### 6. Create the GitHub App

The runner reads and merges PRs as a GitHub App, not as your `gh` login:

```sh
bun scripts/setup-github-app.ts
```

A browser page opens and sends the app manifest to GitHub. Click **Create GitHub App**, pick the repos the factory may work in, and click **Install**. The script saves the app's id, private key and webhook secret to `~/.config/marshal-factory/github-app.json` (mode 600). You can add repos to the installation later in GitHub's app settings.

Now give the ingest Function the real webhook secret:

```sh
neon functions deploy ingest --branch main --src functions/ingest/index.ts \
  --env GITHUB_APP_WEBHOOK_SECRET="$(jq -r .webhook_secret ~/.config/marshal-factory/github-app.json)"
```

### 7. Create the Linear webhook

```sh
bun scripts/install-webhooks.ts
```

This registers a webhook on your team (Issue and Comment events) that points at the ingest Function, and records its id in the config. Running it again reuses the existing webhook.

### 8. Deploy the panel

Import the repo into Vercel as a Next.js project. `vercel.json` already sets the build command (migration guard, then migrations, then build) and the region. Then:

- Add these environment variables for Production. Mark the secrets as Sensitive.
  - `DATABASE_URL`, `DATABASE_URL_UNPOOLED`
  - `NEON_AUTH_BASE_URL`, `NEON_AUTH_COOKIE_SECRET`
  - `NEON_REALTIME_URL`, `NEXT_PUBLIC_NEON_REALTIME_URL`, `NEON_REALTIME_SECRET`
  - `FACTORY_OWNER_EMAILS`
  - `LINEAR_API_KEY`, used by the New job form
  - `FACTORY_TEAM_KEY` and `FACTORY_LABEL`, if they differ from `FAC` and `factory`
- Set the Ignored Build Step to `[ -z "$DATABASE_URL" ]`, so previews without a database are skipped. To get previews with their own Neon branch, connect Neon's Vercel integration. Each preview then migrates its own branch, and the migration guard stops any preview that points at production.

Deploy, then create your owner account. Sign-up is off by default. The [owner account steps](docs/operations.md#panel-access-and-deploys) turn it on briefly, so you can register with an address from `FACTORY_OWNER_EMAILS` and confirm it with the emailed code.

### 9. Start the runner

```sh
bun scripts/install-runner.ts
tail -f ~/Library/Logs/marshal-factory/runner.log
```

This installs the LaunchAgent `com.marshal-factory.runner`. It starts at login and restarts if it exits. Within a minute the log shows `realtime` `live` and a `heartbeat`, and your Mac appears under **Machines** in the panel. The runner still needs a repo to work in, which the next section adds.

## Add your repo

A target repo is any git repo whose `origin` is on GitHub and whose default branch is `main`. The GitHub App must be installed on it.

```sh
bun scripts/install-target.ts ~/code/my-app
```

This writes three things into the repo, all pointing at your live checkout:

- `.claude/settings.json`: the reporter hooks and the budget hook.
- `.mcp.json`: the `factory-report` MCP server.
- `.agents/playbooks/factory.md`: the factory playbook.

It merges with any settings the repo already has, adds `.claude/**` to the ESLint ignores when it can, and adds the repo to `factory.repos` in your config. Running it again changes nothing.

Commit those files and push them to `main`. Every thread starts from a fresh worktree of `origin/main`, so a thread can only see the playbook and hooks once they're on `main`.

Then restart the runner so it loads the new repo: `bun scripts/install-runner.ts --uninstall && bun scripts/install-runner.ts`.

New jobs go to the first repo in `factory.repos`. For now, a single runner works one target repo.

## Use it

**Start a job.** Either:

- In Linear, add the `factory` label to an issue in Todo.
- In the panel, click **New job**, then write a title, a description, and optionally paste or drop images. The panel files the issue in Linear for you.

Within seconds the issue moves to In Progress, a comment says the factory took it, and a card appears on the board. Write the issue the way you would for a colleague who can't ask questions: what's wrong or what you want, and how you'll know it's done. Images on the issue are downloaded and given to the thread.

**Watch it.** Cards move through Queued, Triage, Investigating, Implementing, Verifying and PR. Open a card to see the stage history, the agents and subagents, the models, and the spend. **Other activity** lists Claude Code sessions that report no factory stage, such as work you start by hand in a target repo. **Machines** shows each runner's Mac, its load, and its T3 projects.

**Answer questions.** When the issue is ambiguous or something blocks the run, the card moves to Waiting, and the question is posted as a comment on the Linear issue, usually with options to pick from. Reply with a comment on the issue. The thread continues with your answer.

**Review and merge.** At the PR stage, the issue moves to In Review with a link to the pull request. Review it as you would any PR. You can merge from the panel or on GitHub. Either way, the issue moves to Done and the worktree is cleaned up. If main moves on and the PR conflicts, the factory tells the thread to merge main and fix it.

**Stop a job.** Remove the `factory` label, or cancel the issue. The runner stops the thread.

**When it fails.** A job fails when the agent gives up, when it stays stuck after one nudge, or when it hits its budget (5 USD per attempt by default). The reason is posted on the issue, the issue goes back to Todo, and the label changes to `factory-failed`. To retry, add `factory` again. The retry runs on a new branch (`factory/FAC-7-a2`) with a fresh budget. A failed job's worktree is kept for three days, so you can look at what it did.

## Settings

The optional `factory` object in `~/.config/marshal-factory/config.json` overrides these defaults (from `lib/config.ts`):

- `teamKey` (`FAC`) and `label` (`factory`): the Linear team and label to work on.
- `maxInFlight` (2): how many jobs this Mac runs at once.
- `budgetUsd` (5): what one attempt may spend, main session plus subagents.
- `provider` (`claudeAgent`) and `model` (`claude-opus-5-5`): what new threads run on.
- `stuckAfterMinutes` (30) and `failAfterNudgeMinutes` (30): when a quiet job gets nudged, and when it fails after the nudge.
- `cleanupGraceDays` (3): how long a failed job's worktree is kept.

[docs/operations.md](docs/operations.md) lists the rest.

If you change the team key or label, also change them in the ingest Function (`FACTORY_TEAM_KEY` and `FACTORY_LABEL`, with the `neon functions deploy` command from step 6) and in Vercel. Then rerun `bun scripts/install-webhooks.ts` for a new team.

## Updating

Pull the latest version into the live checkout with the runner paused, so it never runs half-updated code:

```sh
bun scripts/install-runner.ts --uninstall
git pull --ff-only && bun install
bun scripts/install-runner.ts
```

When the panel is deployed from your repo, Vercel runs the new migrations itself when you merge to `main`. Update the live checkout after that deploy is ready. If you update without Vercel, run `bun run db:migrate` first.

## Troubleshooting

- **Start with the runner log**: `~/Library/Logs/marshal-factory/runner.log`. Each line is one JSON event. Errors name the step that failed.
- **An issue isn't picked up.** Check that it is in your team (`teamKey`), has the label, and is in an unstarted state such as Todo. Also check that `factory.repos` isn't empty, and that the Linear webhook exists under Linear → Settings → API. The runner also polls every 90 seconds, so a missed webhook only delays the job.
- **Machine shows offline.** The runner isn't sending heartbeats. Check `launchctl list | grep marshal-factory`, then the log. Run `bun runner/index.ts --once` in the live checkout to do one pass by hand and see its output.
- **The board has no live updates.** Check the three Realtime variables in Vercel. Previews never subscribe to live updates; only production does.
- **A run has no stages or costs.** The target repo's hooks aren't reaching ingest. Check that the files from `install-target` are on the repo's `main`, and that `secret` in your config equals `FACTORY_INGEST_SECRET` in the Function.
- **You moved the live checkout.** The hooks and the LaunchAgent hold its old path. Run `install-target` for each repo and `install-runner` again.

## Developing

Work in a separate clone or worktree, never in the live checkout. Run `bun dev` for the panel against a Neon branch of your own, not `main`.

`bun run test:regressions` runs every `scripts/*-regressions.ts` against a throwaway Neon branch made from production. It deletes the branch when the run ends. Pass a prefix to run a subset, for example `bun run test:regressions ingest`. During a test run, the real Linear client, the GitHub App and `t3` commands refuse to run, so a test can't touch real work.

## Further reading

- [docs/operations.md](docs/operations.md): how each part behaves, including the runner, write-back, retries, budgets, cleanup, the watchdog, sign-in and deploys.
- [playbooks/factory.md](playbooks/factory.md): what each factory thread is told to do.
- [docs/research/](docs/research/): background reports from the initial investigation.
