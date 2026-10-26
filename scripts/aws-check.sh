#!/usr/bin/env bash
# 開発環境（dev）の AWS の状態をまとめて確認し、logs/aws-check.log に保存する（変更はしない）。
# 秘密情報（キーの値・シークレットの中身）は出力しない。
# CLI 用ユーザー（docs/setup/aws-account.md）の権限で読める範囲だけを見る。
set -u
PROFILE="${AWS_PROFILE_NAME:-schedule-app-dev}"
REGION=ap-northeast-1
cd "$(dirname "$0")/.."
mkdir -p logs
LOG=logs/aws-check.log

run() {
  echo "## $1"
  shift
  "$@" 2>&1 | sed -E 's/(AKIA|ASIA)[A-Z0-9]{16}/\1****************/g'
  echo "(exit=${PIPESTATUS[0]})"
  echo
}
awsq() { # $1: リージョン、以降: aws の引数
  local region=$1
  shift
  aws "$@" --region "$region" --profile "$PROFILE" --output text
}

{
  echo "# aws-check $(date '+%Y-%m-%d %H:%M:%S')  profile=$PROFILE"
  echo
  run "ツール" bash -c 'aws --version; cdk --version; node -v; docker --version 2>/dev/null || echo "docker なし"'
  run "認証情報（誰として接続しているか）" aws sts get-caller-identity --profile "$PROFILE"
  for region in "$REGION" us-east-1; do
    run "CDK bootstrap（$region）" awsq "$region" cloudformation describe-stacks --stack-name CDKToolkit \
      --query "Stacks[0].[StackStatus,EnableTerminationProtection]"
  done
  run "SSM パラメータ（固定出口 IP・Cognito の ID など）" awsq "$REGION" ssm get-parameters-by-path \
    --path /schedule-app/dev --recursive --query "Parameters[].[Name,Value]"
  for s in ai-schedule-app/google-maps-api-key ai-schedule-app/google-maps-api-key_web ai-schedule-app/navitime-rapidapi-key; do
    run "シークレット ${s}（存在・形式・キー名のみ。値は出さない）" bash -c "
      aws secretsmanager describe-secret --secret-id '$s' --region $REGION --profile $PROFILE \
        --query '[Name,ARN]' --output text || exit 1
      aws secretsmanager get-secret-value --secret-id '$s' --region $REGION --profile $PROFILE --output json \
        | python3 -c '
import json, sys
v = json.load(sys.stdin)
if v.get(\"SecretString\") is None:
    print(\"形式: バイナリ（SecretBinary）またはテキストなし\")
else:
    try:
        d = json.loads(v[\"SecretString\"])
        print(\"形式: JSON / キー名:\", sorted(d.keys()) if isinstance(d, dict) else type(d).__name__)
    except ValueError:
        print(\"形式: プレーンテキスト（JSONではない）、長さ\", len(v[\"SecretString\"]))
'"
  done
  # 証明書は ALB 用（東京）と CloudFront 用（us-east-1）の2つ
  for region in "$REGION" us-east-1; do
    run "証明書（$region）" awsq "$region" acm list-certificates \
      --query "CertificateSummaryList[?contains(DomainName,'super-ai-schedule-app.com')].[DomainName,Status]"
  done
  run "Route 53 ドメイン" awsq "$REGION" route53 list-hosted-zones --query "HostedZones[].Name"
} >"$LOG" 2>&1

echo "完了しました。結果は $LOG に保存しました。"
