# infra（AWS CDK）

TypeScript の CDK アプリ。ルートの npm workspaces に含まれる。

## スタック

上から順に依存する。作成済みのものだけ `lib/build-app.ts` で組み立て、残りは各 WBS タスクで追加する。

| スタック | 内容 | WBS | 状態 |
| --- | --- | --- | --- |
| `ScheduleApp-<stage>-EgressIp` | 外部 API 向けの固定出口 IP（Elastic IP）。削除しても IP は保持 | 2.1 | dev 作成済み |
| `ScheduleApp-<stage>-CertCloudFront` | CloudFront 用の証明書（us-east-1、`<appDomain>` と `*.<appDomain>`） | 1.4 | dev 作成済み |
| `ScheduleApp-<stage>-CertAlb` | ALB 用の証明書（東京、同上） | 1.4 | dev 作成済み |
| `ScheduleApp-<stage>-Network` | VPC・サブネット・NAT Gateway（EgressIp の IP を使う）・セキュリティグループ | 2.2 | コード作成済み（2.10 でデプロイ） |
| `ScheduleApp-<stage>-Data` | Aurora Serverless v2・Secrets Manager・ログ用 S3 | 2.3 | コード作成済み（2.10 でデプロイ） |
| `ScheduleApp-<stage>-Auth` | Cognito User Pool・App Client | 2.4 | コード作成済み（2.10 でデプロイ） |
| `ScheduleApp-<stage>-App` | ECS Fargate（ARM64）・ALB（HTTPS のみ）・`origin.<appDomain>`。イメージは `server/Dockerfile`。バッチ（EventBridge Scheduler）は 7.2 | 2.5・7.2 | 2.5 分はコード作成済み（2.10 でデプロイ） |
| `ScheduleApp-<stage>-Web` | S3＋CloudFront・WAF | 2.6・9.2 | 未作成 |
| `ScheduleApp-<stage>-Pipeline` | CodePipeline／CodeBuild | 2.7 | 未作成 |
| `ScheduleApp-<stage>-Ops` | CloudWatch アラーム・ダッシュボード・Billing Alarm | 9.1 | 未作成 |

## 環境ごとの設定（`lib/config.ts`）

| 項目 | dev | stg | prod |
| --- | --- | --- | --- |
| URL | dev.super-ai-schedule-app.com | stg.super-ai-schedule-app.com | super-ai-schedule-app.com |
| VPC（仮置き。1.10 で確定） | 10.100.0.0/16 | 10.101.0.0/16 | 10.102.0.0/16 |
| AZ／NAT Gateway | 2／1 | 2／1 | 2／2 |
| ECS（vCPU・メモリ／台数） | 0.25・0.5GB／1〜2 | 0.25・0.5GB／1〜2 | 0.25・0.5GB／2〜4 |
| Aurora（ACU／読み取り） | 0（自動停止）〜2／なし | 0.5〜2／なし | 0.5〜4／1（Multi-AZ） |
| バックアップ／削除保護 | 7日／なし | 7日／あり | 7日／あり |
| Cognito の削除保護 | なし | あり | あり |
| ログ保持 | 30日 | 90日 | 90日 |

## 使い方（リポジトリ直下から）

```bash
npm run infra:release   # テスト→型チェック→差分表示→確認（y）→デプロイ→状態確認（dev のみ）
                        # 2.10 までは デプロイ済みの3スタック（EgressIp・Cert*）だけが対象
npm run aws:check       # 状態の確認のみ（変更しない）。結果は logs/aws-check.log
npm run infra:diff      # 変更内容の確認
npm run infra:deploy    # デプロイ（dev、上と同じ3スタックのみ）
npm run infra:ip        # 出口 IP の表示（Google キーの IP 制限に登録する値）
```

他の環境は `cd infra && cdk deploy --all -c stage=stg --profile schedule-app-dev` のように指定する。

## 前提

- `cdk bootstrap` 済み（ap-northeast-1・us-east-1、削除保護あり、権限の上限なし）。
- 認証情報は `docs/setup/aws-account.md` のプロファイル `schedule-app-dev`。
