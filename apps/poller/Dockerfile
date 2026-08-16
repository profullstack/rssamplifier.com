# syntax=docker/dockerfile:1
# Build from the repo root:
#   docker build -f apps/poller/Dockerfile .
FROM node:22-alpine
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo
COPY . .
# The poller and its packages are plain ESM with no build step, so a production
# install is all this needs.
RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
CMD ["node", "apps/poller/src/index.js"]
