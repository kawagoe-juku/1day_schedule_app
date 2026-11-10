# AIスケジュール外出支援サービス（Web版）

外出の予定を自然文で入力すると、出発から帰宅までの行動計画（出発時刻・乗換・駅出口・立寄り先）を生成し、地図とタイムラインで示すWebアプリ。

- 要件・設計の元資料（発注元から受け取った原本。変更しない）：[`docs/Alli/`](docs/Alli/)
- 試験項目書：[`docs/試験項目書/`](docs/試験項目書/)
- 詳細設計書（draw.io、16ページ）：[`docs/design/詳細設計書.drawio`](docs/design/詳細設計書.drawio)
- 設計判断の記録：[`docs/adr/`](docs/adr/)
- API仕様：[`api/openapi.yaml`](api/openapi.yaml)

## ディレクトリ構成

```text
.
├── api/            API仕様（openapi.yaml が正。Swagger Editor 等で閲覧）。サーバ・アプリの実装はこれに合わせる
├── app/            Flutter Web クライアント
├── server/         サーバ（TypeScript + Fastify）。/api と /agent を提供
├── infra/          AWS CDK（[`infra/README.md`](infra/README.md)）
├── docs/
│   ├── Alli/          要件定義書・見積書・DB定義書・エンティティ定義・紙芝居HTML
│   ├── adr/           設計判断の記録
│   ├── design/        詳細設計書（draw.io）・DB 定義書（PostgreSQL 版）・DB 定義の追加カラム
│   ├── setup/         開発端末・AWS アカウントのセットアップ手順
│   └── 試験項目書/     結合試験項目書・総合試験項目書
├── scripts/        開発・デプロイ用スクリプト（npm scripts から呼ぶ）
└── docker-compose.yml  ローカル開発用 PostgreSQL
```

## 必要なもの

| ツール | バージョン | 用途 |
| --- | --- | --- |
| Node.js | 22 LTS（`.nvmrc`） | サーバ・CDK |
| Docker Desktop | 最新 | ローカルDB |
| Flutter SDK | 安定版（Web有効） | クライアント |
| AWS CLI / AWS CDK | v2 | デプロイ・AWS の状態確認 |

インストール手順は [`docs/setup/dev-machine.md`](docs/setup/dev-machine.md)（macOS）を参照。

## はじめかた

```bash
# 1. 依存関係をインストール
npm install

# 2. ローカルDBを起動（初回はイメージを取得）
npm run db:up

# 3. サーバの環境変数を用意
cp server/.env.example server/.env

# 4. ローカルDBにテーブルを作成
npm run db:migrate

# 5. サーバを起動（ファイル変更で自動再起動）
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
| `npm run test:db` | DB を使うテスト（ローカルDBが必要。テスト用の `schedule_app_test` を自動で作り、データは残さない） |
| `npm run lint` | ESLint と Prettier のチェック |
| `npm run format` | Prettier で整形 |
| `npm run typecheck` | TypeScript の型チェック |
| `npm run build` | サーバをビルド（`server/dist`） |
| `npm run api:check` | OpenAPI 定義のチェック（参照切れ・要件APIの網羅） |
| `npm run db:up` / `db:down` | ローカルDBの起動・停止 |
| `npm run db:psql` | ローカルDBに psql で接続 |
| `npm run db:migrate` | 未適用のマイグレーションを適用（接続先は `server/.env` の `DATABASE_URL`） |
| `npm run db:rollback` | 直近のマイグレーションを1件取り消す（テーブルとデータが消える。本番では実行できない） |
| `npm run db:generate -- --name <名前>` | スキーマ定義の変更からマイグレーションの SQL を作る |
| `npm run aws:check` | 開発環境の AWS の状態確認（変更しない。結果は `logs/aws-check.log`） |
| `npm run infra:release` | 開発環境への手動デプロイ（初回・障害時用）。テスト→差分表示→確認のうえデプロイ |
| `npm run -s dev:token -- <メール>` | 開発環境にログインしてアクセストークンを出力（API の動作確認用。`server/.env` の Cognito の設定を使う） |
| `npm run tools:setup` | AWS CLI・AWS CDK の導入と Docker の確認（macOS、初回のみ） |
| `npm run app:setup` | Flutter（Web）環境のセットアップと動作確認（macOS、初回のみ） |
| `npm run app:dev` | Webアプリを Chrome で起動 |
| `npm run app:test` | Webアプリの静的解析とテスト |
| `npm run app:build` | Webアプリをビルド（`app/build/web`） |

## Feature Flag

「準備のみ」の機能は Feature Flag で止めてある。切り替えは環境変数だけで行い、既定はすべて OFF（`true` のときだけ ON。`true`／`false` 以外は起動時にエラー）。定義は `server/src/features.ts`。

| 環境変数 | 機能 |
| --- | --- |
| `FEATURE_VOICE_INPUT` | 音声入力 |
| `FEATURE_NOTIFICATION` | 通知の配信 |
| `FEATURE_POSTPONE_REPLAN` | 延期再計画 |
| `FEATURE_DEPARTURE_DETECTION` | 出発検知 |
| `FEATURE_OPERATION_MONITORING` | 運行情報の監視 |
| `FEATURE_STAGED_NOTIFICATION` | 出発アラートの段階通知 |

OFF の機能の API は、処理の最初に `assertFeatureEnabled(config, '<機能名>')` を呼び、`501 FEATURE_DISABLED` を返す。

## 外部 API クライアント

外部 API は `server/src/adapters/` のクライアント経由で呼ぶ（`createExternalClients(config)` で作る）。

| ファイル | 呼び出し先 |
| --- | --- |
| `google-maps.ts` | Geocoding API、Places API (New)、Routes API（徒歩・自転車・車） |
| `navitime.ts` | NAVITIME（RapidAPI）：乗換経路 `route_transit`、駅名の候補 `transport_node/autocomplete` |
| `http.ts` | 共通処理：タイムアウト（既定4秒）、やり直し（既定1回。5xx・429・タイムアウト・通信エラーのみ） |
| `metrics.ts` | 呼び出し回数のメトリクス（CloudWatch の Embedded Metric Format を標準出力に1行ずつ出す） |

- 失敗は `ExternalApiError` になり、API としては `502 EXTERNAL_SERVICE_ERROR` を返す。原因はログにだけ残す。
- メトリクスは名前空間 `ScheduleApp/ExternalApi` の `CallCount`・`DurationMs`（区分：Stage・Service・Operation・Outcome）。やり直しも1回ずつ数える。
- RapidAPI は API ごとに購読が必要。駅名の候補は「NAVITIME Transport」の購読が要る（乗換経路の「Route(totalnavi)」とは別）。

## DB マイグレーション

テーブル定義の正は [`docs/design/DB定義書.md`](docs/design/DB定義書.md)。マイグレーションは Drizzle ORM（drizzle-kit）で管理する。

| 場所 | 内容 |
| --- | --- |
| `server/src/db/schema.ts` | スキーマ定義（TypeScript） |
| `server/src/db/client.ts` | DB 接続（`createDb`）とトランザクションの型 |
| `server/src/db/repositories/` | テーブルごとのリポジトリ（`repositories(db)` でまとめて得る） |
| `server/drizzle/NNNN_<名前>.sql` | 適用する SQL（`db:generate` が作る。手で直さない） |
| `server/drizzle/down/NNNN_<名前>.sql` | 取り消す SQL（手で書く。無いとテストが失敗する） |

テーブル定義を変えるとき：

1. `docs/design/DB定義書.md` と `server/src/db/schema.ts` を変更する。
2. `npm run db:generate -- --name <名前>` で SQL を作り、内容を確かめる。
3. 同じ名前で `server/drizzle/down/` に取り消し用の SQL を書く。
4. ローカルDBで `npm run db:migrate` → `npm run db:rollback` → `npm run db:migrate` が通ることを確かめる。

開発環境（Aurora）への適用手順はまだ用意していない（自動デプロイには組み込んでいない）。

## デプロイ

開発環境（<https://dev.super-ai-schedule-app.com>）へは、GitHub の `main` への push で自動デプロイする（CodePipeline。失敗時はメールで通知）。構成・初回の準備・手動デプロイは [`infra/README.md`](infra/README.md)、AWS アカウントと権限の準備は [`docs/setup/aws-account.md`](docs/setup/aws-account.md) を参照。

## 開発のルール

ブランチ運用・コミットメッセージ・コーディング規約は [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照。
