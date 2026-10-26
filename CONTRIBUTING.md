# 開発規約

## ブランチ運用

| ブランチ | 用途 |
| --- | --- |
| `main` | 常にデプロイ可能な状態。直接コミットしない |
| `feature/<WBS番号>-<概要>` | 機能開発。例：`feature/5.2-intent-analysis` |
| `fix/<概要>` | 不具合修正 |

- 作業は `main` からブランチを切り、プルリクエストで `main` に取り込む。
- マージ前に `npm run lint`・`npm run typecheck`・`npm test` がすべて通っていること。

## コミットメッセージ

```text
<種別>: <内容（日本語可）>

例）feat: 計画生成APIに確認質問の上限制御を追加
```

| 種別 | 内容 |
| --- | --- |
| feat | 機能追加 |
| fix | 不具合修正 |
| docs | ドキュメント |
| refactor | 動作を変えない整理 |
| test | テストの追加・修正 |
| chore | ビルド・依存関係・設定 |

## コーディング規約（サーバ・CDK：TypeScript）

- 整形は Prettier、静的チェックは ESLint（typescript-eslint）に従う。手で整形ルールを議論しない。
- `strict` を有効にし、`any` は使わない（やむを得ない場合は理由をコメントする）。
- ESM（`"type": "module"`）。相対 import には拡張子 `.js` を付ける。
- 入力値の検証は zod またはルートの JSON スキーマで行い、`api/openapi.yaml` と一致させる。
- エラーは `AppError` を throw し、共通エラー形式（`{ error: { code, message, requestId } }`）で返す。
- ログは `request.log` / `app.log`（pino）を使い、`console.log` は使わない。
- パスワード・トークン・APIキー・位置座標の生データをログに出さない。
- 秘密情報をコードや `.env.example` に書かない。本番は Secrets Manager から取得する。

## 命名

| 対象 | 規則 | 例 |
| --- | --- | --- |
| ファイル | kebab-case | `plan-service.ts` |
| 型・クラス | PascalCase | `PlanItem` |
| 変数・関数 | camelCase | `createPlan` |
| 定数 | UPPER_SNAKE_CASE | `DAILY_PLAN_LIMIT` |
| DB テーブル・カラム | snake_case | `plan_item.start_time` |
| API の JSON | camelCase | `startTime` |

## テスト

- テストは `server/test/` に置き、ファイル名は `*.test.ts`。
- 外部サービス（Bedrock・Google Maps・乗換案内・カレンダー）は単体テストではモックにする。
- 不具合を直すときは、再現するテストを先に追加する。

## API 仕様の変更

1. `api/openapi.yaml` を先に変更し、`npm run api:check` を通す。
2. サーバとアプリの実装を合わせる。
3. 要件定義書と異なる点は、OpenAPI の `info.description` の「要件定義からの差分」に追記する。

## 設計判断の記録（ADR）

技術選定など後から理由を知りたくなる判断は、`docs/adr/NNNN-<概要>.md` に記録する。
