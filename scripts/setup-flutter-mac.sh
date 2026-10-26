#!/usr/bin/env bash
# Flutter（Web）開発環境のセットアップ（macOS・WBS 1.2）
# 使い方：リポジトリ直下で  bash scripts/setup-flutter-mac.sh
# 何度実行しても安全（入っているものはスキップ）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$REPO_ROOT/app"
ok()   { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[注意]\033[0m %s\n' "$*"; }
ng()   { printf '\033[31m[NG]\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

step "1. 前提の確認"
[[ "$(uname -s)" == "Darwin" ]] || { ng "macOS で実行してください"; exit 1; }
ok "macOS $(sw_vers -productVersion)（$(uname -m)）"
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
# 以前この方法で入れた Flutter があれば、このシェルで使えるようにする
[[ -x "$FLUTTER_HOME/bin/flutter" ]] && export PATH="$FLUTTER_HOME/bin:$PATH"
if command -v flutter >/dev/null 2>&1; then
  ok "Flutter はインストール済み：$(command -v flutter)"
elif command -v brew >/dev/null 2>&1; then
  brew install --cask flutter
  ok "Flutter をインストールしました（Homebrew）"
else
  mkdir -p "$(dirname "$FLUTTER_HOME")"
  echo "Flutter（stable）を取得しています。数分かかります…"
  git clone -b stable https://github.com/flutter/flutter.git "$FLUTTER_HOME"
  export PATH="$FLUTTER_HOME/bin:$PATH"
  ok "Flutter を $FLUTTER_HOME にインストールしました"
fi
# 新しいターミナルでも flutter が使えるよう ~/.zshrc に PATH を追記（1回だけ）
if [[ -x "$FLUTTER_HOME/bin/flutter" ]] && ! grep -q 'development/flutter/bin' "$HOME/.zshrc" 2>/dev/null; then
  echo 'export PATH="$HOME/development/flutter/bin:$PATH"' >> "$HOME/.zshrc"
  ok "~/.zshrc に PATH を追記しました（新しいターミナルから有効）"
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

step "5. Flutter プロジェクト（app/）の作成"
if [[ -f "$APP_DIR/pubspec.yaml" ]]; then
  ok "app/ はすでに Flutter プロジェクトです（作成をスキップ）"
else
  KEEP_README="$(mktemp)"
  [[ -f "$APP_DIR/README.md" ]] && cp "$APP_DIR/README.md" "$KEEP_README"
  (cd "$APP_DIR" && flutter create . --project-name ai_schedule_app --platforms web \
     --description "AIスケジュール外出支援サービス（Web版）")
  [[ -s "$KEEP_README" ]] && cp "$KEEP_README" "$APP_DIR/README.md"
  ok "app/ に Flutter プロジェクトを作成しました（README.md は元の内容を維持）"
fi

step "6. 動作確認（依存取得・静的解析・テスト・Webビルド）"
cd "$APP_DIR"
flutter pub get
flutter analyze
flutter test
flutter build web
ok "Webビルド成功：app/build/web"

step "7. ほかの開発ツールの状況（1.2 の完了確認用・参考）"
for c in node npm docker aws cdk; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c: $($c --version 2>&1 | head -1)"; else warn "$c: 未インストール（docs/setup/dev-machine.md 参照）"; fi
done

step "完了"
echo "画面を起動するには：  cd app && flutter run -d chrome"
echo "（ルートからは  npm run app:dev  でも起動できます）"
