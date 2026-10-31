# Moving to another machine

The runner is the only part of the factory tied to a machine. Neon, the panel on Vercel, the GitHub App and the Linear webhook stay as they are; the new machine only needs the files the runner reads and the same machine id. These steps move it to another Mac, or into the [runner container](runner-container.md) on a Linux host.

## What carries over

`bun scripts/move.ts pack` collects these into one encrypted bundle, and `unpack` puts them back:

| File | What it holds |
| --- | --- |
| `.env.local` in the live checkout | The Neon connection strings and secrets, the Linear key, the ingest secret, and tokens such as `CLAUDE_CODE_OAUTH_TOKEN` and `UPSTASH_BOX_API_KEY` |
| `.neon` and `.vercel/project.json` in the live checkout | Which Neon and Vercel projects the checkout is linked to, for the CLIs, the doctor and the setup wizard |
| `~/.config/marshal-factory/config.json` | The factory settings, including `factory.machineId` |
| `~/.config/marshal-factory/github-app.json` | The GitHub App's id, private key and webhook secret |
| `~/.config/marshal-factory/sandbox-image.json`, `sandbox-image.upstash.json` | The Modal image and the Upstash snapshot already built, so the new machine doesn't build them again |
| `~/.config/marshal-factory/rollout.json` | The last commit rolled out, which the next rollout compares against |
| `~/.modal.toml` | The Modal token |
| `auth.json` and `config.toml` in each Codex slot (`factory.sandbox.codexSlots`) | The Codex logins |

You redo what lives in the old machine's keychain or apps: `gh auth login`, `neon auth`, `vercel login`, Claude Code with PStack, and T3 Code if jobs run on the machine itself.

## Why the machine id matters

A job belongs to the machine that claimed it: its stops, answers, merges and post-merge watch all run there. The runner names its machine by `factory.machineId` in `config.json`, or, without one, by the Mac's hardware UUID. The new machine has a different UUID, so `pack` writes the old id into `factory.machineId` before it bundles the config. To the factory the new machine is then the same machine: it keeps its row under **Machines**, and a job waiting in a Modal sandbox or an Upstash box (in **PR** or **Waiting**) carries on from the new machine, since the sandbox lives in the cloud.

Run one runner per machine id. Two runners with the same id would both act for its jobs, so the old runner must stay stopped once the new one starts.

## Before you move

1. Press **Pause new work** on the panel's **Queue** page, so no runner claims or starts anything new.
2. Let the jobs that only this machine can finish end. `pack` refuses until there are none:
   - jobs in flight, from **Queued** to **Verifying**, wherever they run;
   - jobs that run on this Mac's T3 and wait in **PR** or **Waiting**, whose worktrees stay on this Mac. Answer, merge or close them;
   - merges still in their post-merge watch (`postMergeWatchMinutes`, 60 by default).

## Move to another Mac

On the old Mac, in the live checkout:

```sh
bun scripts/move.ts pack ~/factory.bundle
```

It counts the jobs above, stops the runner, and counts again, starting the runner again if a job was claimed in between. Then it pins `factory.machineId`, asks for a passphrase and writes the bundle (mode 600, AES-256 through `openssl`). Last, it removes the LaunchAgent's plist, so the old runner doesn't come back at the next login.

Copy the bundle to the new Mac, for example with AirDrop or `scp`. On the new Mac, set up the tools from [What you need](../README.md#what-you-need), then:

```sh
git clone https://github.com/<you>/marshal-factory.git ~/code/marshal-factory
cd ~/code/marshal-factory
bun install
bun scripts/move.ts unpack ~/factory.bundle
bun scripts/install-runner.ts
bun scripts/doctor.ts
```

`unpack` refuses to overwrite a file that exists; move it aside, or pass `--force`. When the doctor is clean, press **Resume** on the **Queue** page, and delete the bundle on both machines.

Keep the checkout at the same path, under the same user name, if you can. The reporter hooks that `install-target` committed to your target repos name the live checkout by its full path. At a new path, run `bun scripts/install-target.ts <repo>` for each repo and push the change to `main`. `factory.repos` in `config.json` lists the target repos' local checkouts too: clone them at the same paths, or remove the ones the new Mac doesn't have.

## Move into the runner container

On the host, in a clone of the factory:

```sh
bun install
bun scripts/move.ts unpack factory.bundle --home ./.runner-home
sudo chown -R 1000:1000 .runner-home
FACTORY_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
```

`--home` puts the files from your home directory into the container's runner home, where the runner finds them as `/home/bun/...`. That includes `.modal.toml`, so the container needs no `MODAL_TOKEN_ID` in `.env.local`. Then run the doctor in the image ([runner-container.md](runner-container.md#start-it)), and resume new work.

To move from a container, stop it first (`docker compose down`), then pack the home its configs live in. With the standard `compose.yaml` that is the runner home: `bun scripts/move.ts pack factory.bundle --home ./.runner-home`, and its `config.json` must already have `factory.machineId`. When a `compose.override.yaml` mounts your own `~/.config/marshal-factory` and `~/.modal.toml` into the container, as on a Mac that runs it, leave `--home` off.

## By hand

Without the script: pause and drain as above, then stop the old runner (`bun scripts/install-runner.ts --uninstall`, and delete `~/Library/LaunchAgents/com.marshal-factory.runner.plist`). Add the old machine's id to `factory` in `config.json` as `"machineId"`. On a Mac without one set, it's the IOPlatformUUID that `ioreg -rd1 -c IOPlatformExpertDevice` prints. Copy the files in the table to the same places on the new machine with mode 600, and continue with `install-runner` and the doctor.
