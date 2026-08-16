# syntax=docker/dockerfile:1
# Built from the repo root:
#   docker build -f apps/poller/Dockerfile .
FROM node:22-alpine
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo
COPY pnpm-workspace.yaml package.json ./
COPY packages/feed/package.json    packages/feed/
COPY packages/ingest/package.json  packages/ingest/
COPY apps/poller/package.json      apps/poller/
RUN pnpm install --prod

COPY packages ./packages
COPY apps/poller ./apps/poller

ENV NODE_ENV=production
CMD ["node", "apps/poller/src/index.js"]
