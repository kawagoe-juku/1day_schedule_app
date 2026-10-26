# ADR-0001 サーバの言語・フレームワーク

- 状態：決定
- 決定日：2026-10-15
- 決定者：前田
- 関連タスク：WBS 1.6

## 背景

サーバは ECS Fargate 上の単一コンテナで、`/api/*`（APIサービス）と `/agent/*`（AI連携基盤）を提供する。要件定義書に言語の指定はない。主な前提は次のとおり。

- AI推論は Amazon Bedrock（Converse API、Tool Use）
- 認証は Cognito 発行の JWT をアプリ層で検証
- DB は Aurora Serverless v2（PostgreSQL）、秘密情報は Secrets Manager
- インフラは AWS CDK でコード化
- 開発は1名＋AI支援、期間は 2026/10/19〜12/25

## 比較

| 観点 | TypeScript＋Fastify | Python＋FastAPI | Dart（Dart Frog 等） |
| --- | --- | --- | --- |
| Bedrock Converse・Tool Use | AWS SDK v3 で公式対応、型付き | boto3 で公式対応、型情報は弱い | 公式 SDK なし（自前実装） |
| Cognito JWT 検証 | aws-jwt-verify（AWS 公式） | python-jose 等 | 自前実装 |
| CDK との言語統一 | 同じ（CDK の標準言語） | 別言語になる | 別言語になる |
| OpenAPI との整合 | 定義から型生成、zod で入力検証 | コードから自動生成 | 限定的 |
| ECS での運用 | 起動が速く軽量 | 問題なし | 実績が少ない |
| AI 評価スクリプト | 書けるがやや冗長 | 最も書きやすい | 不向き |
| 工期リスク | 低 | 低〜中（2言語運用） | 高 |

## 決定

**TypeScript（Node.js 22）＋ Fastify 5** を採用する。

- インフラ（CDK）とサーバを同じ言語にそろえ、型・設定・ツールを共有する。
- Bedrock・Cognito・Secrets Manager を AWS 公式の SDK とライブラリで扱える。
- OpenAPI（`api/openapi.yaml`）を正とし、サーバ・Flutter の両方で型を生成する。

## 付随して決めたこと

| 項目 | 採用 |
| --- | --- |
| ランタイム | Node.js 22 LTS |
| パッケージ管理 | npm workspaces（`server` と `infra`） |
| 入力検証・設定検証 | zod |
| DB アクセス・マイグレーション | Drizzle ORM ＋ drizzle-kit（2.9・3.1 で導入） |
| JWT 検証 | aws-jwt-verify（2.8 で導入） |
| テスト | Vitest |
| Lint・整形 | ESLint（typescript-eslint）＋ Prettier |
| ログ | Fastify 標準の pino（JSON 構造化ログ） |

## 影響

- プロンプト評価などの補助スクリプトも、原則 TypeScript（tsx で実行）で書く。
- Python が明らかに有利な分析が出てきた場合は、本番コードに含めない補助ツールとしてのみ使う。
