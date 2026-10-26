# syntax=docker/dockerfile:1
# サーバ（/api・/agent）のコンテナイメージ。ビルドはリポジトリ直下をコンテキストにする：
#   docker build -f server/Dockerfile -t schedule-app-server .
# ECS Fargate（ARM64）で動かす。

# ---- ビルド
# ベースイメージは Docker Hub の取得回数制限を避けるため、同じ公式イメージを ECR Public から取得する
FROM public.ecr.aws/docker/library/node:22-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY infra/package.json infra/
RUN npm ci -w @ai-schedule-app/server --include-workspace-root=false
COPY server/tsconfig.json server/tsconfig.build.json server/
COPY server/src server/src
RUN npm run build -w @ai-schedule-app/server

# ---- 実行
FROM public.ecr.aws/docker/library/node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY infra/package.json infra/
RUN npm ci -w @ai-schedule-app/server --include-workspace-root=false --omit=dev && npm cache clean --force
COPY --from=build /repo/server/dist server/dist
# Aurora は TLS 必須のため、RDS の CA 証明書を同梱して接続先を検証する
# 置き場所は先に作る（ADD に任せると --chmod がフォルダにも掛かり、node ユーザーが読めなくなる）
RUN mkdir -p -m 755 /app/certs
# 中身が変わったらビルドを止める（RDS が CA を更新したら、新しい値を確かめてから checksum を差し替える）
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem
ENV DB_SSL_CA_PATH=/app/certs/rds-global-bundle.pem
USER node
EXPOSE 3000
CMD ["node", "server/dist/server.js"]
