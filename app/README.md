# app（Flutter Web クライアント）

現状は雛形で、全画面の空ページとその間の画面遷移だけがある。各画面の中身は、空ページに書いてある WBS のタスクで実装する。画面は `docs/Alli/紙芝居html/HTML_0831/`（画面の見本 HTML）に合わせる。

## 構成

| 場所 | 内容 |
| --- | --- |
| `lib/main.dart`・`lib/app.dart` | 起動とアプリ全体の設定 |
| `lib/config/app_config.dart` | 接続先の切り替え |
| `lib/api/` | API の呼び出し。`generated/` は自動生成（手で編集しない） |
| `lib/routing/app_router.dart` | 画面のパスと画面遷移（go_router） |
| `lib/theme/app_theme.dart` | 配色・寸法・部品の見た目（画面の見本の `css/common.css` に合わせる） |
| `lib/widgets/` | 複数の画面で使う部品。`AppFrame` は全画面共通の枠（見出し・本文・下部の操作） |
| `lib/screens/` | 画面（1画面1ファイル） |

状態管理は Riverpod（`main.dart` の `ProviderScope`）。

## 画面とパス

| パス | 画面 | 見本 | 実装するタスク |
| --- | --- | --- | --- |
| `/` | ホーム／入力 | 2.2.2 | 6.1 |
| `/login` | ログイン（サインイン・サインアップ・パスワードリセット） | 2.2.1 | 4.3 |
| `/onboarding` | 初回オンボーディング | 2.2.1 | 4.5 |
| `/plans/<計画ID>` | 行動計画結果 | 2.2.3 | 6.2・6.3 |
| `/routines` | ルーティン設定 | 2.2.4 | 7.3 |
| `/memos` | メモ・買い物リスト | 2.2.5 | 7.4 |
| `/settings` | アカウント・設定 | 2.2.6 | 8.5 |
| `/settings/profile` | プロファイル編集 | 2.2.7 | 8.5 |

未ログインのときはログイン画面へ、ログイン済みで初回設定が済んでいないときは初回設定へ送る（`redirectFor`）。

## 認証

Cognito（メールアドレス＋パスワード）に Amplify Flutter でつなぐ。

| 場所 | 内容 |
| --- | --- |
| `lib/auth/auth_service.dart` | 認証の操作と失敗の種類（画面はこれだけを使う） |
| `lib/auth/amplify_auth_service.dart` | Amplify を使った実体 |
| `lib/auth/session_controller.dart` | ログインの状態。起動時の復元、無操作24時間での打ち切り（`sessionIdleTimeout`）、アクセストークンの受け渡し |
| `lib/auth/validators.dart` | メールアドレス・パスワード・確認コードの入力チェック |

- Cognito の接続先（User Pool ID など）は、起動時に `GET /api/config` で取得する。ビルド時の設定は要らない。
- 手元では、手元のサーバ（`npm run dev`）の `server/.env` に書いた Cognito（開発環境のもの）につながる。
- テストでは `test/auth/fake_auth_service.dart` の代用品を使う。実際の Cognito とのやり取りは、結合試験で確かめる。

## 接続先の切り替え

ビルド・起動時に `--dart-define` で指定する。

| 指定 | 内容 |
| --- | --- |
| `APP_ENV` | 環境名。`local`（既定）・`dev`・`stg`・`prod` |
| `API_BASE_URL` | 接続先の上書き（任意）。画面と API を別のドメインで動かすときだけ使う |

API の接続先は、どの環境でも「画面と同じドメインの `/api`・`/agent`」。開発・検証・本番では CloudFront が、手元では画面の開発サーバ（`web_dev_config.yaml`）が、手元のサーバ（`npm run dev`、ポート 3000）へ転送する。

自動デプロイでは、`scripts/ci-build.sh` がデプロイ先の環境名（`STAGE`）を `APP_ENV` に渡す。手元でのビルドは `APP_ENV=dev npm run app:build` のように指定する。

## コマンド

リポジトリのルートで実行する。

| コマンド | 内容 |
| --- | --- |
| `npm run app:setup` | Flutter（Web）環境のセットアップ（初回のみ） |
| `npm run app:dev` | Chrome で起動 |
| `npm run app:test` | 静的解析とテスト |
| `npm run app:generate` | API クライアント（`lib/api/generated/`）を `api/openapi.yaml` から作り直す |
| `npm run app:build` | ビルド（出力先は `app/build/web`。デプロイ時に S3 へ配置される） |

## API の呼び出し

`api/openapi.yaml` を変えたら `npm run app:generate` を実行し、生成物もコミットする（合っていないと自動デプロイの最初で止まる）。

```dart
final api = ref.watch(apiProvider);
try {
  final profile = await api.profile.getProfile();
} on Object catch (error) {
  final failure = ApiException.from(error); // 種類・利用者向けメッセージ・項目別の入力エラー
}
```

- **認証**：認証が必要な API には、`Authorization: Bearer <JWT>` を自動で付ける（`lib/api/api_client.dart`）。トークンはログインの状態（`SessionController`）から取得し、期限が近ければ自動で更新される。
- **失敗**：通信ライブラリの例外は、`ApiException`（`lib/api/api_exception.dart`）に変換して扱う。
- **null の項目**：API が null を返す項目は、Dart では `String?` のような「省略できる項目」になる。生成前に仕様を整え（`scripts/openapi-for-dart.mjs`）、応答の null は読む前に取り除いている。更新 API に null を送りたい項目は、省略して送る。

## 共通のエラー表示

| 部品 | 使いどころ |
| --- | --- |
| `AsyncValueView`（`lib/widgets/async_value_view.dart`） | 取得したデータを出す領域。取得中は進行中の表示、失敗時は「取得に失敗しました」＋「再試行」をその領域の中に出す |
| `LoadErrorView` | 上の失敗時の表示だけを使いたいとき |
| `FormFieldFrame`（`lib/widgets/form_field_frame.dart`） | 入力項目。ラベル・必須の `*`・入力欄のすぐ下の入力エラー。サーバが返した項目別のエラーは `ApiException.fieldErrors` から渡す |

## 採用予定の構成（未導入）

- 地図：google_maps_flutter（Web は google_maps_flutter_web）
