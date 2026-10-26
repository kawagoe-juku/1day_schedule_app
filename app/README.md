# app（Flutter Web クライアント）

現状は雛形で、アプリ名を表示するだけ。画面は `docs/Alli/紙芝居html/HTML_0831/`（画面の見本 HTML）に合わせて実装する。

## コマンド

リポジトリのルートで実行する。

| コマンド | 内容 |
| --- | --- |
| `npm run app:setup` | Flutter（Web）環境のセットアップ（初回のみ） |
| `npm run app:dev` | Chrome で起動 |
| `npm run app:test` | 静的解析とテスト |
| `npm run app:build` | ビルド（出力先は `app/build/web`。デプロイ時に S3 へ配置される） |

## 採用予定の構成（未導入）

- 状態管理：Riverpod
- 地図：google_maps_flutter（Web は google_maps_flutter_web）
- 認証：Amplify Flutter（Cognito）
- API クライアント：`api/openapi.yaml` から生成
