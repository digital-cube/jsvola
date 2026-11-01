# syntax=docker/dockerfile:1
# JSVola server image.
#   docker build -t jsvola .
#   docker run -p 8300:8300 -e VOLA_DATABASE_URL=… -e VOLA_REDIS_URL=… jsvola
# The same image runs the worker later (`node dist/worker.js`, plan 4.1).

ARG NODE_VERSION=24

# --- build: install the workspace, compile, and bundle the server's production tree ------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@vola/server... --filter=@vola/cli...
# Standalone copies of @vola/server and @vola/cli with their production dependencies; the
# workspace packages they use (@vola/core, …) are copied in, not symlinked.
RUN pnpm --config.inject-workspace-packages=true --filter @vola/server deploy --prod /out/app \
 && pnpm --config.inject-workspace-packages=true --filter @vola/cli deploy --prod /out/cli \
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
# System tools the processing worker needs: libvips (sharp thumbnails), pdftoppm (first PDF
# page), tesseract with English, Serbian and German (OCR).
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
    VOLA_STORAGE_PATH=/data/storage
WORKDIR /app
COPY --from=build --chown=node:node /out/app /app
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
CMD ["node", "dist/server.js"]
