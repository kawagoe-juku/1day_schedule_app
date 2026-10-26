# AWS アカウントの準備

AWS アカウントに対して1回だけ行う準備と、権限の分け方。日々のデプロイと運用は [`infra/README.md`](../../infra/README.md) を参照。

方針：**人がコンソールで使うユーザー**と、**Mac の CLI・CDK が使うユーザー**を分ける。
長期間有効なアクセスキーは、権限を絞った CLI 用ユーザーだけに持たせる。

| ユーザー | 用途 | 権限 | 認証 |
| --- | --- | --- | --- |
| 管理者の IAM ユーザー | コンソールと CloudShell（コンソール内のターミナル）での操作 | AdministratorAccess | パスワード＋**MFA**（アクセスキーは作らない） |
| `schedule-app-cli` | Mac からの CDK デプロイ・状態確認・Bedrock 呼び出し | `infra/iam/schedule-app-cli-policy.json` のみ | アクセスキー |

## 手順

### 1. 初期準備（cdk bootstrap）

管理者が CloudShell で実行する（`cdk` が入っていなければ `npx --yes aws-cdk@2 bootstrap …`）。東京（ap-northeast-1）と、CloudFront の証明書用に us-east-1 の2リージョンで行う。

> 権限の上限（`--example-permissions-boundary`）は付けない。CLI 用ユーザーの権限を絞っていること、開発環境のみであることが理由。本番環境を作る前に再検討する。

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
for region in ap-northeast-1 us-east-1; do
  cdk bootstrap aws://$ACCOUNT/$region \
    --termination-protection \
    --tags Project=schedule-app --tags Env=dev
done
```

2つのリージョンで `Environment aws://.../<リージョン> bootstrapped.` と出れば完了。

| オプション | 効果 |
| --- | --- |
| `--termination-protection` | CDKToolkit スタックの誤削除を防ぐ |
| `--tags` | 費用をプロジェクト別に集計できるようにする |

### 2. CLI 用ポリシーとユーザーを作る（コンソール）

1. アカウントIDを埋めたポリシーをクリップボードにコピーする（Mac）：`sed 's/<ACCOUNT_ID>/<12桁のID>/g' infra/iam/schedule-app-cli-policy.json | pbcopy`
2. IAM →「ポリシー」→「ポリシーの作成」→「JSON」に貼り付け、名前を `schedule-app-cli` にして作成。
3. IAM →「ユーザー」→「ユーザーの作成」：名前 `schedule-app-cli`、**コンソールアクセスはなし**、「ポリシーを直接アタッチ」で `schedule-app-cli` を選んで作成。
4. 作ったユーザー →「セキュリティ認証情報」→「アクセスキーを作成」→ 用途「CLI」。

### 3. Mac のプロファイルに CLI 用ユーザーを設定する

```bash
aws configure --profile schedule-app-dev     # 手順2のアクセスキー、リージョンは ap-northeast-1
aws sts get-caller-identity --profile schedule-app-dev
# Arn が .../user/schedule-app-cli になっていれば OK
```

### 4. 管理者ユーザーの保護

管理者ユーザーに **MFA** を設定する（「セキュリティ認証情報」→「MFA デバイスの割り当て」→ スマホの認証アプリ）。アクセスキーがあれば「無効化」→「削除」する。

## CLI 用ユーザーに許可していること

| 許可 | 理由 |
| --- | --- |
| `cdk-hnb659fds-*` ロール（`cdk bootstrap` が作るロール）への切り替え | `cdk deploy` / `cdk diff` は CDK のロールに切り替えて作業するため、デプロイはこれだけで足りる |
| Bedrock の Anthropic（Claude）モデル呼び出し | ローカルのサーバから計画生成を試すため。地域横断の推論プロファイルに対応するためリージョンは `*` |
| Bedrock のモデル一覧の取得 | 利用可能なモデル ID の確認用 |
| Secrets Manager の読み取り（`ai-schedule-app/*` のみ） | ローカルのサーバが外部 API キーを読み込むため |
| CloudFormation のスタック情報・SSM パラメータ（`/schedule-app/*`）の読み取り、ACM の証明書・Route 53 のホストゾーンの一覧 | `npm run aws:check` でデプロイ状況を確認するため |

権限が足りない操作が出てきたら、このファイルとポリシーを同時に更新する。

## 管理者が行うこと

上記以外は CLI 用ユーザーではできないので、管理者がコンソールまたは CloudShell で行う。

- SSM パラメータの登録（自動デプロイの失敗通知の宛先 `/schedule-app/dev/ops/notify-email` など）
- GitHub 接続の承認（[`infra/README.md`](../../infra/README.md) の「初回の準備」）
- RDS の操作、Cognito の利用者の管理（テスト用利用者の作成・パスワードの設定）
- CloudWatch Logs の閲覧
- Bedrock の利用申請、請求の確認

### シェルの違い（CloudShell は bash、Mac のターミナルは zsh）

パスワードなどを画面に表示せずに変数へ読むコマンドは、シェルで書き方が違う。

```bash
read -rsp "パスワード: " PW   # bash（CloudShell）
read -rs "PW?パスワード: "    # zsh（Mac）。zsh では read -p は使えない
```

`read` と続きのコマンドを複数行で貼り付けると、次の行が入力として読まれてしまう。`;` で1行にまとめて貼る。

```bash
# 例：CloudShell でテスト用利用者のパスワードを設定する
read -rsp "パスワード: " PW; echo; aws cognito-idp admin-set-user-password --user-pool-id <プールID> --username <メール> --password "$PW" --permanent; unset PW
```

## 後で対応すること

- 本番環境を作る前に、cfn-exec-role（標準は AdministratorAccess）を使うサービスだけに絞ったポリシーへ変更する（`--cloudformation-execution-policies`）。
