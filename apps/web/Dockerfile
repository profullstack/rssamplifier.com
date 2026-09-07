# syntax=docker/dockerfile:1
# Build from the repo root so the workspace packages are in context:
#   docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @rssamplifier/web build

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

# V8 caps the heap at ~4 GB by default regardless of what the container has.
# The web service gets 24 GB on Railway; letting the heap use half of it turns
# a surge that would have been fatal into one that is merely slow. This is a
# ceiling, not a reservation — it costs nothing until it is needed.
#
# This is the ceiling for a single server, which is what the primary process and
# a WEB_WORKERS=1 deployment are. When the primary forks workers it computes
# each one's share of the container's memory and passes it on their command
# line, where it wins over this — see src/lib/workers.js. Sizing it per worker
# here instead would mean this number had to be re-derived by hand every time
# the container changed shape.
ENV NODE_OPTIONS=--max-old-space-size=12288

# server.mjs is `next start`, plus a ceiling on concurrent requests, plus one
# copy of the server per CPU the container is allowed. Reasoning, and the two
# different outages behind the two parts, in src/lib/loadShed.js (memory) and
# src/lib/workers.js (CPU).
CMD ["node", "server.mjs"]
