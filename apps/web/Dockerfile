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
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node_modules/.bin/next", "start", "-p", "3000"]
