#!/usr/bin/env bash
# AWS まわりの状態をまとめて確認し、logs/aws-check.log に保存する。
# 秘密情報（キーの値・シークレットの中身）は出力しない。
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

{
  echo "# aws-check $(date '+%Y-%m-%d %H:%M:%S')  profile=$PROFILE"
  echo
  run "ツール" bash -c 'aws --version; cdk --version; node -v; docker --version 2>/dev/null || echo "docker なし"'
  run "1.3 認証情報（誰として接続しているか）" aws sts get-caller-identity --profile "$PROFILE"
  run "1.3 CDK bootstrap（東京）" aws cloudformation describe-stacks --stack-name CDKToolkit \
    --region "$REGION" --profile "$PROFILE" --query "Stacks[0].[StackStatus,EnableTerminationProtection]" --output text
  run "1.4 CDK bootstrap（us-east-1）" aws cloudformation describe-stacks --stack-name CDKToolkit \
    --region us-east-1 --profile "$PROFILE" --query "Stacks[0].StackStatus" --output text
  run "2.1 固定出口IP" aws ssm get-parameters-by-path --path /schedule-app/dev/network --recursive \
    --region "$REGION" --profile "$PROFILE" --query "Parameters[].[Name,Value]" --output text
  for s in ai-schedule-app/google-maps-api-key ai-schedule-app/google-maps-api-key_web ai-schedule-app/navitime-rapidapi-key; do
    run "1.1 シークレット ${s}（存在・形式・キー名のみ。値は出さない）" bash -c "
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
  run "1.4 証明書（東京・ALB用）" aws acm list-certificates --region "$REGION" --profile "$PROFILE" \
    --query "CertificateSummaryList[?contains(DomainName,'super-ai-schedule-app.com')].[DomainName,Status]" --output text
  run "1.4 証明書（us-east-1・CloudFront用）" aws acm list-certificates --region us-east-1 --profile "$PROFILE" \
    --query "CertificateSummaryList[?contains(DomainName,'super-ai-schedule-app.com')].[DomainName,Status]" --output text
  run "1.4 Route 53 ドメイン" aws route53 list-hosted-zones --profile "$PROFILE" --query "HostedZones[].Name" --output text
} >"$LOG" 2>&1

echo "完了しました。結果は $LOG に保存しました（Claude が読み取ります）。"
