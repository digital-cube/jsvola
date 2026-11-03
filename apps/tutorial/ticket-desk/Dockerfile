FROM docker.io/library/node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY . .
USER node
# Node 24 runs TypeScript as it is: there is no build step for the server.
CMD ["node", "src/server/main.ts"]
