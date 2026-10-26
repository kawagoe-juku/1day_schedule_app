# AWS アカウントの準備（WBS 1.3）

方針：**人がコンソールで使うユーザー**と、**Mac の CLI・CDK が使うユーザー**を分ける。
長期間有効なアクセスキーは、権限を絞った CLI 用ユーザーだけに持たせる。

| ユーザー | 用途 | 権限 | 認証 |
| --- | --- | --- | --- |
| 前田さんの IAM ユーザー（既存） | コンソール操作・初期準備 | AdministratorAccess（現状のまま） | パスワード＋**MFA** |
| `schedule-app-cli`（新規） | Mac からの CDK デプロイ・Bedrock 呼び出し | `infra/iam/schedule-app-cli-policy.json` のみ | アクセスキー |

## 手順

### 1. 初期準備（cdk bootstrap）

管理者ユーザーで実行する（CLI 用ユーザーに切り替えた後は、コンソールの CloudShell で実行する）。東京（ap-northeast-1）と、CloudFront の証明書用に us-east-1 の2リージョンで行う。

> 権限の上限（`--example-permissions-boundary`）は付けない（10/26 決定）。CLI 用ユーザーの権限を絞っていること、開発環境のみであることが理由。本番環境の権限を絞る作業（WBS 9.7 の前）で再検討する。

```bash
aws sts get-caller-identity --profile schedule-app-dev   # Account の12桁を控える

cdk bootstrap aws://<アカウントID>/ap-northeast-1 \
  --termination-protection \
  --tags Project=schedule-app --tags Env=dev
```

`Environment aws://.../ap-northeast-1 bootstrapped.` と出れば完了。

| オプション | 効果 |
| --- | --- |
| `--termination-protection` | CDKToolkit スタックの誤削除を防ぐ |
| `--tags` | 費用をプロジェクト別に集計できるようにする |

### 2. CLI 用ポリシーとユーザーを作る（コンソール）

1. アカウントIDを埋めたポリシーをクリップボードにコピーする：`sed 's/<ACCOUNT_ID>/<12桁のID>/g' infra/iam/schedule-app-cli-policy.json | pbcopy`
2. IAM →「ポリシー」→「ポリシーの作成」→「JSON」に貼り付け、名前を `schedule-app-cli` にして作成。
3. IAM →「ユーザー」→「ユーザーの作成」：名前 `schedule-app-cli`、**コンソールアクセスはなし**、「ポリシーを直接アタッチ」で `schedule-app-cli` を選んで作成。
4. 作ったユーザー →「セキュリティ認証情報」→「アクセスキーを作成」→ 用途「CLI」。

### 3. Mac のプロファイルを CLI 用ユーザーに切り替える

```bash
aws configure --profile schedule-app-dev     # 新しいアクセスキーで上書き
aws sts get-caller-identity --profile schedule-app-dev
# Arn が .../user/schedule-app-cli になっていれば OK
```

### 4. 前田さんのユーザーの後片付け

1. 手順1で使った**前田さんのユーザーのアクセスキーを「無効化」→「削除」**する（以後 CLI では使わない）。
2. 前田さんのユーザーに **MFA** を設定する（「セキュリティ認証情報」→「MFA デバイスの割り当て」→ スマホの認証アプリ）。

## このポリシーで許可していること

| 許可 | 理由 |
| --- | --- |
| `cdk-hnb659fds-*` ロールへの切り替え | `cdk deploy` / `cdk diff` は CDK のロールに切り替えて作業するため、これだけで足りる |
| Bedrock の Anthropic（Claude）モデル呼び出し | ローカルのサーバから計画生成を試すため（WBS 1.8 以降）。地域横断の推論プロファイルに対応するためリージョンは `*` |
| Bedrock のモデル一覧の取得 | 利用可能なモデル ID の確認用 |
| Secrets Manager の読み取り（`ai-schedule-app/*` のみ） | サーバが外部 API キーを読み込むため |
| CloudFormation・SSM（`/schedule-app/*`）・Route 53 の参照 | `npm run aws:check` でデプロイ状況を確認するため |

上記以外（コンソールでの確認、Bedrock の利用申請、請求の確認など）は前田さんのユーザーで行う。
権限が足りない操作が出てきたら、このファイルとポリシーを同時に更新する。

## 後で対応すること

- 本番環境を作る前に、cfn-exec-role（標準は AdministratorAccess）を使うサービスだけに絞ったポリシーへ変更する（`--cloudformation-execution-policies`）。
