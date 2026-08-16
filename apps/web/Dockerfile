# syntax=docker/dockerfile:1
# Built from the repo root so the workspace packages are in context:
#   docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json ./
COPY packages/feed/package.json    packages/feed/
COPY packages/ingest/package.json  packages/ingest/
COPY apps/web/package.json         apps/web/
# No lockfile is committed yet, so this resolves fresh. Swap to
# --frozen-lockfile once pnpm-lock.yaml is checked in.
RUN pnpm install

FROM base AS build
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN pnpm --filter @rssamplifier/web build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
# Next's standalone bundle already contains the server and the pruned
# node_modules, so the runtime image needs neither pnpm nor the workspace.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
