# The runner as a container, for an always-on host instead of the Mac's LaunchAgent; see
# docs/runner-container.md. Jobs run in Modal or Upstash sandboxes, so the image holds no T3.
#   FACTORY_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
FROM oven/bun:1.4.4-slim

# git for the post-merge revert; the image has no .git, so the build passes the commit instead.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

ARG FACTORY_COMMIT=""
# Without it a sandbox image rebuild fails after its snapshot, on the git rev-parse it can't run.
RUN test -n "$FACTORY_COMMIT" || { echo 'FACTORY_COMMIT is required: FACTORY_COMMIT=$(git rev-parse HEAD) docker compose up -d --build' >&2; exit 1; }
ENV FACTORY_COMMIT=$FACTORY_COMMIT

# HOME (/home/bun) is a volume: the configs, the sandbox image records and the runner's state.
USER bun
CMD ["bun", "runner/index.ts"]
