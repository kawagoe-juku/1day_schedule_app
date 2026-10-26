# infra（AWS CDK）

TypeScript の CDK アプリ。ルートの npm workspaces に含まれる。アプリのスタックは `lib/build-app.ts`、自動デプロイのスタックは `lib/pipeline-stack.ts` で組み立てる。

この文書は構成・デプロイ・運用を扱う。AWS アカウントと権限の準備は [`docs/setup/aws-account.md`](../docs/setup/aws-account.md)、開発端末の準備は [`docs/setup/dev-machine.md`](../docs/setup/dev-machine.md)。

## 前提

- **AWS アカウント**：`cdk bootstrap` 済み（ap-northeast-1・us-east-1、削除保護あり、権限の上限なし）。アカウント ID とホストゾーンの検索結果は `cdk.context.json`、GitHub のリポジトリ名は `lib/config.ts` にあり、このアカウント・リポジトリ専用の値である。
- **認証情報**：プロファイル `schedule-app-dev`（CLI 用ユーザー）。`cdk` は CDK のロールに切り替えてデプロイするので、このユーザー自身はリソースを直接操作できない。RDS・Cognito の管理、ログの閲覧、SSM の登録などは管理者が CloudShell で行う（[`docs/setup/aws-account.md`](../docs/setup/aws-account.md)）。
- **ドメイン**：Route 53 にホストゾーン `super-ai-schedule-app.com` がある。
- **Bedrock**：東京リージョンで Anthropic のモデルを利用できる状態にしてある。
- **外部 API キー**：Secrets Manager に次を登録してある（dev は環境名なし、stg・prod は `ai-schedule-app/<stage>/…`）。未登録だとサーバのタスクが起動できない。値の形式は JSON で、キー名は `lib/secrets.ts` のとおり。
  - `ai-schedule-app/google-maps-api-key`（キー `I_SCHEDULE_APP_FOR_SERVER`。サーバ用、IP 制限あり）
  - `ai-schedule-app/navitime-rapidapi-key`（キー `NAVITIME_RAPIDAPI_KEY`）
  - `ai-schedule-app/google-maps-api-key_web`（画面用。画面の実装時に使う。`aws:check` で存在だけ確認する）
- **CDK CLI**：`cdk` コマンドはグローバルに導入したもの（`npm i -g aws-cdk`）を使う。自動デプロイは `npx aws-cdk@2` を使う。
- テスト（vitest）も `cdk.json` の推奨設定（feature flags）で synth する（`vitest.config.ts`）。

## スタック

| スタック | 内容 |
| --- | --- |
| `ScheduleApp-<stage>-EgressIp` | 外部 API 向けの固定出口 IP（Elastic IP）。Google のサーバ用キーの IP 制限に登録する。削除しても IP は保持 |
| `ScheduleApp-<stage>-CertCloudFront` | CloudFront 用の証明書（us-east-1、`<appDomain>` と `*.<appDomain>`） |
| `ScheduleApp-<stage>-CertAlb` | ALB 用の証明書（東京、同上） |
| `ScheduleApp-<stage>-Network` | VPC・サブネット・NAT Gateway（EgressIp の IP を使う）・セキュリティグループ |
| `ScheduleApp-<stage>-Auth` | Cognito User Pool・Web 用 App Client |
| `ScheduleApp-<stage>-Data` | Aurora Serverless v2・Secrets Manager・ログ用 S3 |
| `ScheduleApp-<stage>-App` | ECS Fargate（ARM64、イメージは `server/Dockerfile`）・ALB（HTTPS のみ）・`origin.<appDomain>` |
| `ScheduleApp-<stage>-Web` | S3＋CloudFront（`/*` は画面、`/api/*`・`/agent/*` は ALB へ転送） |
| `ScheduleApp-GitHubConnection` | GitHub との接続（CodeConnections、旧称 CodeStar Connections。環境に共通） |
| `ScheduleApp-<stage>-PipelineArtifacts` | 自動デプロイが us-east-1 へのデプロイに使う成果物置き場（us-east-1、S3 バケットのみ） |
| `ScheduleApp-<stage>-Pipeline` | 自動デプロイ（CDK Pipelines）と失敗通知（EventBridge → SNS → メール） |

下の3つは自動デプロイのある環境（`lib/config.ts` の `ci` がある環境。現在は dev のみ）にだけ作る。

スタック間の値は CDK のオブジェクト参照で受け渡す（`cdk.json` の推奨設定により、別リージョンも含めて出力値の参照になる）。synth 時に SSM パラメータを検索する方法（`valueFromLookup`）は、CDK の検索用ロールに `/schedule-app/*` を読む権限がないため使わない。SSM の値は確認用で、例外として失敗通知の宛先だけは、リポジトリに書かないためデプロイ時に CloudFormation が SSM から読む。

## 環境ごとの設定（`lib/config.ts`）

| 項目 | dev | stg | prod |
| --- | --- | --- | --- |
| URL | dev.super-ai-schedule-app.com | stg.super-ai-schedule-app.com | super-ai-schedule-app.com |
| VPC（社内ネットワークとの重複確認までの仮の値） | 10.100.0.0/16 | 10.101.0.0/16 | 10.102.0.0/16 |
| AZ／NAT Gateway | 2／1 | 2／1 | 2／2 |
| ECS（vCPU・メモリ／台数） | 0.25・0.5GB／1〜2 | 0.25・0.5GB／1〜2 | 0.25・0.5GB／2〜4 |
| ECS Exec（コンテナに入って調査） | あり | あり | なし |
| Aurora（ACU／読み取り） | 0（自動停止）〜2／なし | 0.5〜2／なし | 0.5〜4／1（Multi-AZ） |
| バックアップ | 7日 | 7日 | 7日 |
| 削除保護（DB・Cognito・ALB。削除時もログ・S3 を残す） | なし | あり | あり |
| ログ保持 | 30日 | 90日 | 90日 |

## 自動デプロイ（`lib/pipeline-stack.ts`）

GitHub の `main` に push すると、CodePipeline が次の順に dev へ反映する。どこかで失敗したら止まり、メールで知らせる（宛先は SSM パラメータ `/schedule-app/dev/ops/notify-email`）。

1. **Source**：GitHub から取得する
2. **Build**（`scripts/ci-build.sh`）：lint・型チェック・テスト・API 仕様のチェック → 画面の解析・テスト・ビルド → `cdk synth`
3. **UpdatePipeline**：パイプライン自身の変更を反映する
4. **Assets**：サーバのイメージ（ARM64）と画面ファイルなどを置く
5. **dev**：全スタックを依存順にデプロイする

自動デプロイのある環境では、アプリのスタックはパイプラインの中（`ScheduleApp-<stage>-Pipeline/<stage>/…`）にだけ置く。外にも置くと、構成のパスが論理 ID に入るリソース（DB のシークレット・SG のルールなど）が手動とパイプラインで食い違い、同名のリソースの作成で失敗するため。`cdk` コマンドで指定するときもこのパスを使う（CloudFormation 上のスタック名は `ScheduleApp-<stage>-…` のまま）。

us-east-1 の証明書スタックをデプロイするには、us-east-1 に成果物置き場が要る。CDK が自動で作る受け渡し用スタックは CLI 用ユーザーの権限では作れないため、通常のスタック（PipelineArtifacts）として用意してパイプラインに渡している。

画面のビルドに使う Flutter の版は `lib/config.ts` の `FLUTTER_VERSION`。手元の版を上げたら合わせて変える。

### 初回の準備（1回だけ）

1. 管理者が CloudShell で、失敗通知の宛先を登録する（リポジトリには書かない。CLI 用ユーザーは SSM に登録できない）。

   ```bash
   aws ssm put-parameter --name /schedule-app/dev/ops/notify-email --type String \
     --value '<宛先のメールアドレス>' --region ap-northeast-1
   ```

2. GitHub 接続を作る。

   ```bash
   cd infra && cdk deploy ScheduleApp-GitHubConnection -c stage=dev --profile schedule-app-dev
   ```

3. 管理者が AWS コンソールの「デベロッパー用ツール」→「設定」→「接続」で `schedule-app-github` を開き、「保留中の接続を更新」→ GitHub で承認する。
4. パイプラインを手動でデプロイする（成果物置き場も一緒に作られる）。以後は push で自動実行され、パイプライン自身の変更も自動で反映される。

   ```bash
   cd infra && cdk deploy ScheduleApp-dev-Pipeline -c stage=dev --profile schedule-app-dev
   ```

5. 届いた確認メール（AWS Notifications）のリンクを開き、通知を有効にする。

## 手動デプロイと確認（リポジトリ直下から）

通常の反映は自動デプロイで行う。手動デプロイは初回や障害時に使う。

```bash
npm run infra:release   # テスト→型チェック→差分表示→確認（y）→デプロイ→状態確認（dev のみ）
                        # 既定は dev の全アプリスタック（ScheduleApp-dev-Pipeline/dev/*）
                        # 個別は DEPLOY_STACKS='ScheduleApp-dev-Pipeline/dev/ScheduleApp-dev-App' など
                        # パイプライン自身は DEPLOY_STACKS=ScheduleApp-dev-Pipeline
npm run aws:check       # 状態の確認のみ（変更しない）
AWS_PROFILE=schedule-app-dev bash scripts/ci-build.sh  # Build 段と同じ確認を手元で行う
```

- 結果は `logs/`（`infra-deploy.log`・`aws-check.log`）に保存する。`logs/` と `cdk.out/` は作業用で、コミットしない。
- `ci-build.sh` は `npm ci` で node_modules を作り直し、Flutter がなければ `$HOME/flutter` に取得する。
- 手動デプロイには Docker（サーバのイメージのビルド）と、ビルド済みの画面（`npm run app:build`）が要る。
- 自動デプロイのない環境（stg・prod）は `cd infra && cdk deploy --all -c stage=stg --profile schedule-app-dev` のように指定する。

### dev の API を確かめる

テスト用利用者のアクセストークン（JWT）は `npm run -s dev:token -- <メール>` で取得する（画面と同じ SRP 方式。接続先は `server/.env` の `COGNITO_USER_POOL_ID`・`COGNITO_WEB_CLIENT_ID`）。パスワードは画面に表示せずに入力する。

```bash
TOKEN=$(npm run -s dev:token -- you@example.com)
curl -H "Authorization: Bearer $TOKEN" https://dev.super-ai-schedule-app.com/api/session
```

対話なしで実行するときは、パスワードを環境変数 `DEV_TOKEN_PASSWORD` で渡す。

## 運用上の注意

- **固定出口 IP**：外部 API へは EgressIp スタックの Elastic IP から出る。Google のサーバ用キーの IP 制限にはこの IP を登録する（値は `npm run aws:check` の SSM パラメータ `network/egress-ip-*/public-ip` で確認できる）。
- **画面ファイル**：Web スタックは `app/build/web` がビルド済みのときだけ S3 に配置する。ないときは synth で警告が出るので、先に `flutter build web` を実行する。
- **CloudFront → ALB のヘッダー**（`X-Origin-Verify`、シークレット `ai-schedule-app/<stage>/origin-verify`）：値はデプロイ時に CloudFront と ALB の両方へ読み込まれる。手で値を変えると両者が食い違い `/api` が 404 になるため、ローテーションはしない。変えるときは App と Web を続けてデプロイする。
- **証明書の受け渡し**：CloudFront 用証明書（us-east-1）は、CertCloudFront の出力値を東京の Web スタックが参照する。証明書を作り直すと ARN が変わるので、続けて Web もデプロイする。この参照は CloudFormation が依存を守らないため、削除は Web → CertCloudFront の順に行う。
- **dev の作り直し**：シークレットは削除後も最大30日は同じ名前で作れない。すぐ作り直すときは `aws secretsmanager delete-secret --secret-id <名前> --force-delete-without-recovery` で完全に削除する。
- **RDS の CA 証明書**：`server/Dockerfile` はビルド時に AWS の CA バンドルを取得し、checksum で検証する。AWS がバンドルを更新するとビルドが失敗するので、新しい checksum（`sha256sum`）に差し替える。
- **dev の DB の自動停止**：dev の Aurora は使われないと停止する。停止中の最初の `/api/health/ready` は 503 になり、起動後（数十秒）に 200 に戻る。
