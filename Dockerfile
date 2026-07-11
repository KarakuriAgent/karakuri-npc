# syntax=docker/dockerfile:1

# ---- ビルド（server の tsc + web の vite build） ----
# better-sqlite3 のビルドフォールバックに備えて full イメージ（python3/make/g++ 入り）を使う
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps ./apps
RUN npm run build

# ---- 実行用依存（server のみ、devDependencies なし） ----
FROM node:22 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w @karakuri-npc/server

# ---- 実行イメージ ----
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8300 \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=deps /app /app
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8300
CMD ["node", "apps/server/dist/index.js"]
