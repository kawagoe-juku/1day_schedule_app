# AIスケジュール外出支援サービス（Web版）

外出の予定を自然文で入力すると、出発から帰宅までの行動計画（出発時刻・乗換・駅出口・立寄り先）を生成し、地図とタイムラインで示すWebアプリ。

- 要件・設計の元資料：[`docs/Alli/`](docs/Alli/)
- 試験項目書：[`docs/試験項目書/`](docs/試験項目書/)
- 詳細設計書（draw.io、16ページ）：[`docs/design/詳細設計書.drawio`](docs/design/詳細設計書.drawio)
- 設計判断の記録：[`docs/adr/`](docs/adr/)
- API仕様：[`api/openapi.yaml`](api/openapi.yaml)

## ディレクトリ構成

```text
.
├── api/            API仕様（openapi.yaml が正。Swagger Editor 等で閲覧）。サーバ・アプリの型生成の元
├── app/            Flutter Web クライアント
├── server/         サーバ（TypeScript + Fastify）。/api と /agent を提供
├── infra/          AWS CDK（[`infra/README.md`](infra/README.md)）
├── docs/
│   ├── Alli/          要件定義書・見積書・DB定義書・エンティティ定義・紙芝居HTML
│   ├── adr/           設計判断の記録
│   ├── design/        詳細設計書（draw.io）
│   ├── setup/         開発端末・AWS アカウントのセットアップ手順
│   └── 試験項目書/     結合試験項目書・総合試験項目書
├── scripts/        開発用スクリプト
└── docker-compose.yml  ローカル開発用 PostgreSQL
```

## 必要なもの

| ツール | バージョン | 用途 |
| --- | --- | --- |
| Node.js | 22 LTS（`.nvmrc`） | サーバ・CDK |
| Docker Desktop | 最新 | ローカルDB |
| Flutter SDK | 安定版（Web有効） | クライアント |
| AWS CLI / AWS CDK | v2 | デプロイ |

インストール手順は [`docs/setup/dev-machine.md`](docs/setup/dev-machine.md) を参照。

## はじめかた

```bash
# 1. 依存関係をインストール
npm install

# 2. ローカルDBを起動（初回はイメージを取得）
npm run db:up

# 3. サーバの環境変数を用意
cp server/.env.example server/.env

# 4. サーバを起動（ファイル変更で自動再起動）
npm run dev
```

起動の確認：

```bash
curl http://localhost:3000/api/health        # {"status":"ok","version":"0.1.0"}
curl http://localhost:3000/api/health/ready  # {"status":"ok","checks":{"db":"ok"}}
```

`/api/health/ready` の `db` が `ng` の場合は、`npm run db:up` でDBが起動しているか確認する。

## よく使うコマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | サーバを開発モードで起動 |
| `npm test` | 単体テスト（Vitest） |
| `npm run lint` | ESLint と Prettier のチェック |
| `npm run format` | Prettier で整形 |
| `npm run typecheck` | TypeScript の型チェック |
| `npm run build` | サーバをビルド（`server/dist`） |
| `npm run api:check` | OpenAPI 定義のチェック（参照切れ・要件APIの網羅） |
| `npm run db:up` / `db:down` | ローカルDBの起動・停止 |
| `npm run db:psql` | ローカルDBに psql で接続 |
| `npm run aws:check` | AWS の状態確認（変更しない。結果は `logs/aws-check.log`） |
| `npm run infra:release` | インフラのテスト→差分表示→確認のうえ開発環境へデプロイ |
| `npm run tools:setup` | AWS CLI・AWS CDK の導入と Docker の確認（初回のみ） |
| `npm run app:setup` | Flutter（Web）環境のセットアップと動作確認（初回のみ） |
| `npm run app:dev` | Webアプリを Chrome で起動 |
| `npm run app:test` | Webアプリの静的解析とテスト |
| `npm run app:build` | Webアプリをビルド（`app/build/web`） |

## 開発のルール

ブランチ運用・コミットメッセージ・コーディング規約は [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照。
