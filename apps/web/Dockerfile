# syntax=docker/dockerfile:1
# Build from the repo root so the workspace packages are in context:
#   docker build -f apps/web/Dockerfile .
# Bun is the package manager and the runtime. Alpine on purpose: dev2's compose
# healthcheck runs busybox `wget`, which the alpine image already has.
FROM oven/bun:1.4.2-alpine AS base

FROM base AS build
WORKDIR /repo
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @rssamplifier/web build

FROM base AS runner
WORKDIR /repo
ENV NODE_ENV=production
# The whole workspace, node_modules included. Next's standalone output would be
# smaller, but its dependency tracing does not survive pnpm's symlinked store —
# it omits next's own @swc/helpers and the bundle dies on boot. See
# apps/web/next.config.mjs.
COPY --from=build /repo ./
WORKDIR /repo/apps/web

# No -p flag and no PORT default: the platform injects PORT and the server
# reads it. A hardcoded port here would leave the router talking to a port
# nothing is listening on.
EXPOSE 3000
ENV HOSTNAME=0.0.0.0

# No NODE_OPTIONS heap ceiling any more: under Bun (JavaScriptCore) V8's
# --max-old-space-size does nothing, in this process or on the workers' command
# lines (src/lib/workers.js still passes it; Bun accepts and ignores it). What
# bounds memory now is the RSS recycle in src/lib/workers.js (a worker past
# recycleRssMb() is replaced) plus the container's mem_limit on dev2.

# server.mjs is `next start`, plus a ceiling on concurrent requests, plus four
# copies of the server (WEB_WORKERS changes the count). Reasoning, and the two
# different outages behind the two parts, in src/lib/loadShed.js (memory) and
# src/lib/workers.js (CPU).
CMD ["bun", "server.mjs"]
