# syntax=docker/dockerfile:1
# Build from the repo root:
#   docker build -f apps/poller/Dockerfile .

# RSSHub, taken from the image its own maintainers build and test.
#
# Not `npm install rsshub` into our image, which was the first attempt and is
# the worse one. That package is published only as `1.0.0-master.<sha>` — a
# rolling build with no stable version to pin — and pulls 83 direct dependencies
# including `patchright`, a Playwright fork whose install downloads a browser.
# Resolving all of that inside our build makes our deploy depend on their
# dependency tree resolving cleanly on the day we ship, for an app we do not
# develop. Copying their published artifact means our build does no resolution.
FROM diygod/rsshub:latest AS rsshub

# Debian trixie and Node 24, because that is exactly what RSSHub's own image is
# (`node:24-trixie-slim`) and this container has to run their `node_modules`.
#
# This was `node:22-alpine` and both halves of that were wrong for the job:
# musl cannot load anything in there linked against glibc, and Node 22 cannot
# load a native addon built for Node 24's ABI. Either mismatch produces the same
# unhelpful shape of failure — an image that builds perfectly and a daemon that
# dies on first require — so the base is pinned to theirs rather than to ours.
#
# The cost, stated because it is not free: CI runs Node 22 (matching the web
# image), so the poller now runs a major this repo's CI does not exercise. The
# suite passes on both today, and 22 is the stricter of the two runners, so the
# gap is in the safe direction — but it is a gap.
FROM node:24-trixie-slim
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo
COPY . .
# The poller and its packages are plain ESM with no build step, so a production
# install is all this needs.
RUN pnpm install --frozen-lockfile --prod

# RSSHub's application, at the path apps/poller/src/rsshub.js expects.
# Deliberately outside /repo: it is not part of this workspace, must never enter
# pnpm-lock.yaml, and must never be walked by anything that scans our
# dependencies.
COPY --from=rsshub /app /opt/rsshub

# The bundled Chromium goes straight back out again — several hundred megabytes
# for routes that need a headless browser to scrape a page. Every route this
# poller asks for is a Twitter one, which is an API call. If a future route does
# need a browser it will fail loudly with a missing-executable error, which is a
# better outcome than carrying the download on every deploy for ever in case.
RUN rm -rf /opt/rsshub/node_modules/.cache/ms-playwright

ENV NODE_ENV=production
CMD ["node", "apps/poller/src/index.js"]
