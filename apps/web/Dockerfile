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

# The heap ceiling for a single server: the primary process, and the one
# process a WEB_WORKERS=1 deployment runs. It equals the container's whole heap
# budget (WEB_HEAP_BUDGET_MB's default in src/lib/workers.js), so one server
# gets what four would have shared.
#
# When the primary forks workers it gives each its share of that budget on
# their command line, where it wins over this. The primary itself only holds
# the socket and stays around 40 MB whatever this says.
#
# It was 12288 until 2026-10-01, sized for Railway's 24 GB container. On a
# shared host that number is a promise to take 12 GB from the neighbours, and a
# ceiling that high is also a licence for V8 to put off collecting — see
# src/lib/workers.js for what that did on dev2. Raise WEB_HEAP_BUDGET_MB and
# this together, or the single-process fallback ends up with a different
# ceiling from the clustered one.
ENV NODE_OPTIONS=--max-old-space-size=4096

# server.mjs is `next start`, plus a ceiling on concurrent requests, plus four
# copies of the server (WEB_WORKERS changes the count). Reasoning, and the two
# different outages behind the two parts, in src/lib/loadShed.js (memory) and
# src/lib/workers.js (CPU).
CMD ["node", "server.mjs"]
