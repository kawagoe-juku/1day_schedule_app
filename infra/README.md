# infra（AWS CDK）

TypeScript の CDK アプリ。ルートの npm workspaces に含まれる。全スタックは `lib/build-app.ts` で組み立てる。

## スタック

| スタック | 内容 |
| --- | --- |
| `ScheduleApp-<stage>-EgressIp` | 外部 API 向けの固定出口 IP（Elastic IP）。削除しても IP は保持 |
| `ScheduleApp-<stage>-CertCloudFront` | CloudFront 用の証明書（us-east-1、`<appDomain>` と `*.<appDomain>`） |
| `ScheduleApp-<stage>-CertAlb` | ALB 用の証明書（東京、同上） |
| `ScheduleApp-<stage>-Network` | VPC・サブネット・NAT Gateway（EgressIp の IP を使う）・セキュリティグループ |
| `ScheduleApp-<stage>-Auth` | Cognito User Pool・Web 用 App Client |
| `ScheduleApp-<stage>-Data` | Aurora Serverless v2・Secrets Manager・ログ用 S3 |
| `ScheduleApp-<stage>-App` | ECS Fargate（ARM64、イメージは `server/Dockerfile`）・ALB（HTTPS のみ）・`origin.<appDomain>` |
| `ScheduleApp-<stage>-Web` | S3＋CloudFront（`/*` は画面、`/api/*`・`/agent/*` は ALB へ転送） |

スタック間の値は CDK のオブジェクト参照で受け渡す（`cdk.json` の推奨設定により、別リージョンも含めて出力値の参照になる）。NAT Gateway の固定 IP だけは、EgressIp を後から変更できるよう SSM パラメータ経由で受け取る。

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

## 使い方（リポジトリ直下から）

```bash
npm run infra:release   # テスト→型チェック→差分表示→確認（y）→デプロイ→状態確認（dev のみ）
                        # 既定はデプロイ済みの3スタック（EgressIp・Cert*）だけ。全体は DEPLOY_STACKS=--all
npm run aws:check       # 状態の確認のみ（変更しない）。結果は logs/aws-check.log
```

他の環境は `cd infra && cdk deploy --all -c stage=stg --profile schedule-app-dev` のように指定する。

## 前提

- `cdk bootstrap` 済み（ap-northeast-1・us-east-1、削除保護あり、権限の上限なし）。
- 認証情報は `docs/setup/aws-account.md` のプロファイル `schedule-app-dev`。
- テスト（vitest）も `cdk.json` の推奨設定（feature flags）で synth する（`vitest.config.ts`）。

## 運用上の注意

- **画面ファイル**：Web スタックは `app/build/web` がビルド済みのときだけ S3 に配置する。ないときは synth で警告が出るので、先に `flutter build web` を実行する。
- **CloudFront → ALB のヘッダー**（`X-Origin-Verify`、シークレット `ai-schedule-app/<stage>/origin-verify`）：値はデプロイ時に CloudFront と ALB の両方へ読み込まれる。手で値を変えると両者が食い違い `/api` が 404 になるため、ローテーションはしない。変えるときは App と Web を続けてデプロイする。
- **証明書の受け渡し**：CloudFront 用証明書（us-east-1）は、CertCloudFront の出力値を東京の Web スタックが参照する。証明書を作り直すと ARN が変わるので、続けて Web もデプロイする。この参照は CloudFormation が依存を守らないため、削除は Web → CertCloudFront の順に行う。
- **dev の作り直し**：シークレットは削除後も最大30日は同じ名前で作れない。すぐ作り直すときは `aws secretsmanager delete-secret --secret-id <名前> --force-delete-without-recovery` で完全に削除する。
