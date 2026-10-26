# infra（AWS CDK）

TypeScript の CDK アプリ。ルートの npm workspaces に含まれる。

## スタック

| スタック | 内容 | 状態 |
| --- | --- | --- |
| `ScheduleApp-<stage>-EgressIp` | 外部 API 向けの固定出口 IP（Elastic IP）。削除しても IP は保持 | 作成済み（dev） |
| Network / Data / Auth / App / Web / Pipeline / Ops | WBS 2.x で追加 | 未作成 |

環境（stage）は `dev`（既定）／`stg`／`prod`。差分は `lib/config.ts` に集める。

## 使い方（リポジトリ直下から）

```bash
npm run infra:diff      # 変更内容の確認
npm run infra:deploy    # デプロイ（dev）
npm run infra:ip        # 出口 IP の表示（Google キーの IP 制限に登録する値）
```

他の環境は `cd infra && cdk deploy --all -c stage=stg --profile schedule-app-dev` のように指定する。

## 前提

- `cdk bootstrap` 済み（`--example-permissions-boundary` 付き）。IAM ロールを作るスタック（WBS 2.x）を追加するときに、同じ境界を `cdk.json` で全ロールに付ける。
- 認証情報は `docs/setup/aws-account.md` のプロファイル `schedule-app-dev`。
