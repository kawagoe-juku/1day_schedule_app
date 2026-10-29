# syntax=docker/dockerfile:1
# サーバ（/api・/agent）のコンテナイメージ。ビルドはリポジトリ直下をコンテキストにする：
#   docker build -f server/Dockerfile -t schedule-app-server .
# ECS Fargate（ARM64）で動かす。

# ---- ビルド
FROM node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY infra/package.json infra/
RUN npm ci -w @ai-schedule-app/server --include-workspace-root=false
COPY server/tsconfig.json server/tsconfig.build.json server/
COPY server/src server/src
RUN npm run build -w @ai-schedule-app/server

# ---- 実行
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY infra/package.json infra/
RUN npm ci -w @ai-schedule-app/server --include-workspace-root=false --omit=dev && npm cache clean --force
COPY --from=build /repo/server/dist server/dist
# Aurora は TLS 必須のため、RDS の CA 証明書を同梱して接続先を検証する
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
ENV DB_SSL_CA_PATH=/app/certs/rds-global-bundle.pem
USER node
EXPOSE 3000
CMD ["node", "server/dist/server.js"]
