#!/usr/bin/env bash
# インフラ（開発環境）のテスト → 型チェック → 差分の確認 → 確認のうえデプロイ → 状態確認 を一括で行う。
# - 差分は画面に表示し、y を入力したときだけデプロイする
# - 対象は開発環境（dev）のみ。検証・本番は手順書に沿って個別に行う
# - 詳細は logs/infra-deploy.log に保存する
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
LOG=logs/infra-deploy.log
PROFILE="${AWS_PROFILE_NAME:-schedule-app-dev}"
STAGE=dev
# デプロイ対象。2.10（開発環境の疎通）まではデプロイ済みの3スタックだけに限定する。
# Network 以降は 2.10 で --all に切り替える（NAT Gateway などの課金が始まるため）。
TARGETS="${DEPLOY_STACKS:-ScheduleApp-dev-EgressIp ScheduleApp-dev-CertCloudFront ScheduleApp-dev-CertAlb}"

step() {
  local title=$1
  shift
  echo "## $title" | tee -a "$LOG"
  if "$@" >>"$LOG" 2>&1; then
    echo "  → OK" | tee -a "$LOG"
  else
    echo "  → NG（詳細は $LOG）" | tee -a "$LOG"
    echo "失敗したため中止しました。Claude に「失敗した」と伝えてください。"
    exit 1
  fi
}

echo "# infra-deploy $(date '+%Y-%m-%d %H:%M:%S')  stage=$STAGE profile=$PROFILE targets=$TARGETS" >"$LOG"
step "1. テスト" npm run test -w infra
step "2. 型チェック" npm run typecheck -w infra

echo "## 3. 差分の確認（変更内容を表示します）" | tee -a "$LOG"
if ! (cd infra && cdk diff $TARGETS -c stage=$STAGE --profile "$PROFILE") 2>&1 | tee -a "$LOG"; then
  echo "差分の確認に失敗したため中止しました。Claude に「失敗した」と伝えてください。"
  exit 1
fi

read -r -p "上の内容で開発環境にデプロイしますか？ [y/N] " answer
if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
  echo "デプロイせずに終了しました。" | tee -a "$LOG"
  exit 0
fi

echo "## 4. デプロイ（証明書の発行待ちなどで数分かかることがあります）"
step "4. デプロイ" bash -c "cd infra && cdk deploy $TARGETS -c stage=$STAGE --profile $PROFILE --require-approval never"
step "5. 状態確認（aws:check）" bash scripts/aws-check.sh
echo "すべて完了しました。結果は $LOG と logs/aws-check.log にあります（Claude が読み取ります）。"
