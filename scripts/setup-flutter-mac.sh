#!/usr/bin/env bash
# Flutter（Web）開発環境のセットアップ（macOS）
# 使い方：リポジトリ直下で  bash scripts/setup-flutter-mac.sh
# 何度実行しても安全（入っているものはスキップ）。
set -euo pipefail

cd "$(dirname "$0")/.."
source scripts/setup-common-mac.sh

step "1. 前提の確認"
FLUTTER_HOME="$HOME/development/flutter"
if command -v brew >/dev/null 2>&1; then
  ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"
else
  warn "Homebrew がないため、Flutter を $FLUTTER_HOME に直接インストールします（管理者権限は不要）"
fi
command -v git >/dev/null 2>&1 || { ng "git がありません。xcode-select --install を実行してから再実行してください"; exit 1; }
ok "git $(git --version | awk '{print $3}')"
if [[ -d "/Applications/Google Chrome.app" ]]; then ok "Google Chrome"; else ng "Google Chrome が見つかりません（Web版の開発に必要）"; exit 1; fi

step "2. Flutter SDK のインストール"
# $FLUTTER_HOME に導入済みなら、このシェルと新しいターミナル（~/.zshrc）で使えるようにする
[[ -x "$FLUTTER_HOME/bin/flutter" ]] && add_path "$FLUTTER_HOME/bin"
if command -v flutter >/dev/null 2>&1; then
  ok "Flutter はインストール済み：$(command -v flutter)"
elif command -v brew >/dev/null 2>&1; then
  brew install --cask flutter
  ok "Flutter をインストールしました（Homebrew）"
else
  mkdir -p "$(dirname "$FLUTTER_HOME")"
  echo "Flutter（stable）を取得しています。数分かかります…"
  git clone -b stable https://github.com/flutter/flutter.git "$FLUTTER_HOME"
  add_path "$FLUTTER_HOME/bin"
  ok "Flutter を $FLUTTER_HOME にインストールしました"
fi
flutter --disable-analytics >/dev/null 2>&1 || true
flutter config --enable-web >/dev/null
flutter --version

step "3. Web 用の部品を取得"
flutter precache --web
ok "Web 用の部品を取得しました"

step "4. flutter doctor（Web のチェックだけ見れば十分）"
flutter doctor || true
echo "※ Xcode・Android Studio・Android toolchain の警告は Web版では無視してよい"

step "5. 動作確認（依存取得・静的解析・テスト・Webビルド）"
cd app
flutter pub get
flutter analyze
flutter test
flutter build web
ok "Webビルド成功：app/build/web"

step "完了"
echo "画面を起動するには：  cd app && flutter run -d chrome"
echo "（ルートからは  npm run app:dev  でも起動できます）"
