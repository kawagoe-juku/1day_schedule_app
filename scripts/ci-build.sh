#!/usr/bin/env bash
# 自動デプロイ（CodeBuild）の Build 段：テスト → 画面のビルド → cdk synth。
# 手元でも同じ手順を確かめられる（Flutter が入っていればそれを使う）。
# 環境変数：STAGE（既定 dev）、FLUTTER_VERSION（Flutter が無いときに取得する版）
set -euo pipefail
cd "$(dirname "$0")/.."
export CI=true # Flutter・npm を CI 向けの動作にする（root 実行の警告や対話を出さない）
STAGE="${STAGE:-dev}"

if ! command -v flutter >/dev/null 2>&1; then
  : "${FLUTTER_VERSION:?Flutter がないため FLUTTER_VERSION を指定してください}"
  echo "## Flutter $FLUTTER_VERSION を取得"
  git clone --quiet --depth 1 --branch "$FLUTTER_VERSION" https://github.com/flutter/flutter.git "$HOME/flutter"
  export PATH="$HOME/flutter/bin:$PATH"
  flutter --disable-analytics >/dev/null
fi
flutter --version

echo "## 依存の取得"
npm ci

echo "## lint・型チェック・テスト・API 仕様のチェック"
npm run lint
npm run typecheck
npm test
npm run api:check

echo "## 画面の静的解析・テスト・ビルド"
(cd app && flutter pub get && flutter analyze && flutter test && flutter build web --release)

echo "## cdk synth（stage=$STAGE）"
(cd infra && npx --yes aws-cdk@2 synth -c stage="$STAGE" --quiet)
