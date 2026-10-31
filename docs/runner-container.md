# Running the runner in a container

The runner can run as a Docker container on an always-on Linux host, such as an EC2 or Lightsail instance in the Neon database's region, instead of as a LaunchAgent on a Mac. The container only fits a factory whose jobs run in Modal or Upstash sandboxes (**Run jobs on** in Settings). It has no T3, so it can't run jobs locally.

## What the host needs

- Docker with the compose plugin.
- A clone of the factory. The image is built from it, and `compose.yaml` mounts its `.env.local`.
- `.env.local`: copy the live checkout's file. Add `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, since the container has no `~/.modal.toml`. A token from `modal token new` works.
- The runner's home, `./.runner-home` by default, or set `FACTORY_RUNNER_HOME` to another path. It becomes `/home/bun` in the container and keeps the configs and the runner's state across restarts. Create `.runner-home/.config/marshal-factory/` and copy these into it from the Mac's `~/.config/marshal-factory/`:
  - `config.json`, with `factory.machineId` set to a fixed name such as `"aws-runner"`. Without it, the machine id falls back to the container's host name.
  - `github-app.json`
  - `sandbox-image.json` and `sandbox-image.upstash.json`, so the runner reuses the images already built instead of building them again.

  The container runs as uid 1000, so that user must be able to write this directory: `sudo chown -R 1000:1000 .runner-home`.

## Start it

```sh
FACTORY_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
docker compose logs -f runner
```

The image has no `.git`, so `FACTORY_COMMIT` gives the runner its commit, and the build stops without it. The heartbeat reports it, and a rebuilt sandbox image records it. Within a minute the log shows `realtime` `live` and a `heartbeat`, and the machine appears under **Machines** with the compose host name, `factory-runner`. The panel shows its memory and disk as unknown, because those readings come from macOS tools.

To check the setup without starting the daemon, run the doctor in the image:

```sh
docker compose run --rm runner bun scripts/doctor.ts
```

The checks for the gh, neon and vercel CLIs, `.neon`, Neon Auth's domain and the heartbeat fail inside the container. They belong to the install, which you do from a checkout, not the runner. Every other check should be `ok`.

## One container per machine id

Run exactly one container for each `factory.machineId`, and give each its own runner home. A job, and every stop, answer, merge and post-merge watch for it, belongs to the machine that claimed it. Two containers with the same id would both act as that owner. Don't use `docker compose up --scale runner=N`: every replica would share one runner home, and so one config and one machine id.

For more throughput, raise `factory.maxInFlight` and `factory.sandbox.maxParallel` in `config.json` before you add a runner. A second runner needs its own clone or compose project, its own runner home and its own `machineId`. It adds capacity, not failover: when a runner is down, its jobs wait for it to come back with the same id, and no other runner takes them over.

## Moving from the Mac

Jobs, and the post-merge watch, stay with the machine that claimed them. Drain the Mac and move it with `bun scripts/move.ts` ([Moving to another machine](moving.md#move-into-the-runner-container)): `pack` on the Mac refuses while it has work only it can finish, stops the LaunchAgent and pins the Mac's machine id. `unpack --home ./.runner-home` on the host fills the runner home, `.modal.toml` included, so the container carries on as the same machine. Resume new work once the container is up.

## Updating

`bun scripts/rollout.ts` drives the LaunchAgent, so it doesn't apply to the container. After a merge to `main`, wait for Vercel's production deploy, which runs the migrations. Then, on the host:

```sh
git pull
FACTORY_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
```

`docker compose` stops the old container with SIGTERM, and the runner finishes its queue before it exits. Redeploy the ingest Function from a checkout when `functions/` or `lib/` changed, as the rollout would.
