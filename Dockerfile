# syntax=docker/dockerfile:1
# JSVola server image.
#   docker build -t jsvola .
#   docker run -p 8300:8300 -e VOLA_DATABASE_URL=… -e VOLA_REDIS_URL=… jsvola
# The same image runs the worker: `docker run … jsvola node dist/worker.js` (the `vola-worker`
# service of docker-compose.yaml).

ARG NODE_VERSION=24

# --- build: install the workspace, compile, and bundle the server's production tree ------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
# …and the examples site (apps/examples, a Vite build) the server serves at / and /en/
# (VOLA_UI_DIR=/app/ui), with its demo pack for `vola demo-seed` (/app/demo-assets).
RUN pnpm turbo run build --filter=@vola/server... --filter=@vola/cli... --filter=@vola/examples
# Standalone copies of @vola/server and @vola/cli with their production dependencies; the
# workspace packages they use (@vola/core, …) are copied in, not symlinked.
RUN pnpm --config.inject-workspace-packages=true --filter @vola/server deploy --prod /out/app \
 && pnpm --config.inject-workspace-packages=true --filter @vola/cli deploy --prod /out/cli \
 && cp -r apps/examples/dist /out/app/ui \
 && cp -r apps/examples/assets /out/app/demo-assets \
 && printf '#!/bin/sh\nexec node /opt/vola-cli/dist/main.js "$@"\n' > /out/vola \
 && chmod 755 /out/vola

# --- runtime ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title="jsvola" \
      org.opencontainers.image.description="Self-hosted, multi-tenant content-addressable file storage" \
      org.opencontainers.image.source="https://github.com/digital-cube/jsvola" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"
# System tools the processing worker needs: libvips (sharp ships its own, this one is for
# `vips` on the command line), pdftoppm (first PDF page), tesseract with English, Serbian and
# German (OCR, plan 4.2).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libvips42 \
      poppler-utils \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-srp tesseract-ocr-deu \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    VOLA_HOST=0.0.0.0 \
    VOLA_PORT=8300 \
    VOLA_PREFIX=/vola \
    VOLA_LOG_LEVEL=info \
    VOLA_STORAGE_PATH=/data/storage \
    VOLA_LOOKUPS_PATH=/app/config/lookups.yaml \
    VOLA_MENU_PATH=/app/config/menu.yaml \
    VOLA_CANDIDATES_DIR=/data/candidates \
    VOLA_UI_DIR=/app/ui \
    VOLA_DEMO_ASSETS=/app/demo-assets
WORKDIR /app
COPY --from=build --chown=node:node /out/app /app
# The vocabulary, its translations and the examples menu (mount your own over /app/config).
COPY --chown=node:node lookups.yaml menu.yaml /app/config/
COPY --chown=node:node i18n /app/config/i18n
# `vola` CLI: `docker compose -f docker-compose.yaml exec vola vola --help`
COPY --from=build /out/cli /opt/vola-cli
COPY --from=build /out/vola /usr/local/bin/vola
COPY --chmod=755 docker/healthcheck.mjs /usr/local/bin/vola-healthcheck
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8300
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=5 \
  CMD ["vola-healthcheck"]
# Applies pending migrations, then listens; SIGTERM closes connections and exits.
# The worker process of the same image: `node dist/worker.js` (needs VOLA_REDIS_URL).
# The examples site (apps/examples) is served at / with VOLA_EXAMPLES=true and the two demo
# keys (docs/EXAMPLES-SITE.md); `vola demo-seed` fills its demo instance.
CMD ["node", "dist/server.js"]
