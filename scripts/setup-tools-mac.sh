#!/usr/bin/env bash
# AWS CLI・AWS CDK・Docker のセットアップ（macOS・WBS 1.2 の残り）
# 使い方：リポジトリ直下で  bash scripts/setup-tools-mac.sh
# 管理者権限なしで入るもの（AWS CLI・CDK）は自動で入れる。Docker は権限が必要なため状況を案内する。
# 何度実行しても安全（入っているものはスキップ）。
set -euo pipefail

ok()   { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[注意]\033[0m %s\n' "$*"; }
ng()   { printf '\033[31m[NG]\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ZSHRC="$HOME/.zshrc"
LOCAL_BIN="$HOME/.local/bin"
add_path() { # $1: ディレクトリ。~/.zshrc に1回だけ追記し、このシェルにも反映
  export PATH="$1:$PATH"
  local line="export PATH=\"$1:\$PATH\""
  grep -qF "$line" "$ZSHRC" 2>/dev/null || { echo "$line" >> "$ZSHRC"; ok "~/.zshrc に PATH を追記：$1"; }
}

step "1. 前提の確認"
[[ "$(uname -s)" == "Darwin" ]] || { ng "macOS で実行してください"; exit 1; }
ok "macOS $(sw_vers -productVersion)（$(uname -m)）"
command -v node >/dev/null 2>&1 || { ng "Node.js がありません（docs/setup/dev-machine.md の2を先に実施）"; exit 1; }
ok "node $(node --version)"
if id -Gn | tr ' ' '\n' | grep -qx admin; then IS_ADMIN=1; ok "このユーザーは管理者グループに属しています"; else IS_ADMIN=0; warn "このユーザーは管理者ではありません（管理者権限が必要なものは案内のみ）"; fi
mkdir -p "$LOCAL_BIN"; add_path "$LOCAL_BIN"

step "2. AWS CLI v2（ユーザー領域に導入・管理者権限不要）"
if command -v aws >/dev/null 2>&1; then
  ok "AWS CLI はインストール済み：$(aws --version 2>&1)"
else
  TMP="$(mktemp -d)"
  curl -fsSL "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "$TMP/AWSCLIV2.pkg"
  cat > "$TMP/choices.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <array>
    <dict>
      <key>choiceAttribute</key><string>customLocation</string>
      <key>attributeSetting</key><string>$HOME</string>
      <key>choiceIdentifier</key><string>default</string>
    </dict>
  </array>
</plist>
XML
  installer -pkg "$TMP/AWSCLIV2.pkg" -target CurrentUserHomeDirectory -applyChoiceChangesXML "$TMP/choices.xml"
  ln -sf "$HOME/aws-cli/aws" "$LOCAL_BIN/aws"
  ln -sf "$HOME/aws-cli/aws_completer" "$LOCAL_BIN/aws_completer"
  ok "AWS CLI を ~/aws-cli にインストールしました：$(aws --version 2>&1)"
fi

step "3. AWS CDK（npm でユーザー領域に導入）"
if command -v cdk >/dev/null 2>&1; then
  ok "AWS CDK はインストール済み：$(cdk --version)"
else
  PREFIX="$(npm config get prefix)"
  if [[ ! -w "$PREFIX/lib" && ! -w "$PREFIX" ]]; then
    npm config set prefix "$HOME/.npm-global"
    add_path "$HOME/.npm-global/bin"
    ok "npm のグローバル領域を ~/.npm-global に変更しました（管理者権限不要にするため）"
  fi
  npm install -g aws-cdk
  hash -r
  ok "AWS CDK をインストールしました：$(cdk --version)"
fi

step "4. Docker（ローカルDB用）"
if command -v docker >/dev/null 2>&1; then
  ok "docker：$(docker --version)"
  if docker info >/dev/null 2>&1; then ok "Docker は起動しています"; else warn "Docker が起動していません。Docker Desktop を起動してから npm run db:up を実行してください"; fi
elif [[ "$IS_ADMIN" == "1" ]]; then
  ARCH="$(uname -m)"; [[ "$ARCH" == "arm64" ]] && DMG="arm64" || DMG="amd64"
  curl -fL "https://desktop.docker.com/mac/main/$DMG/Docker.dmg" -o "$HOME/Downloads/Docker.dmg"
  open "$HOME/Downloads/Docker.dmg"
  warn "Docker Desktop のインストーラーを開きました。Docker のアイコンを Applications にドラッグし、Docker Desktop を起動して初期設定（利用規約への同意）を済ませてください。"
  warn "社内でDocker Desktopの有償ライセンス要否（従業員250人以上または年商1,000万ドル超の組織は有償）を確認してください。"
else
  ng "Docker は管理者権限がないとインストールできません。社内の手続きで Docker Desktop の導入を依頼するか、Claude に「Dockerなしでローカルに PostgreSQL を用意する方法」を相談してください。"
fi

step "5. 結果"
for c in node npm flutter aws cdk docker; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c: $($c --version 2>&1 | head -1)"; else warn "$c: 未インストール"; fi
done
echo
echo "次の作業："
echo "・新しいターミナルを開く（または source ~/.zshrc）と、追加した PATH が有効になります"
echo "・AWS の認証情報は WBS 1.3 で用意したものを設定：aws configure --profile schedule-app-dev（リージョン ap-northeast-1）"
echo "・Docker を入れたら：npm run db:up → npm run dev → curl http://localhost:3000/api/health/ready（\"db\":\"ok\" で 1.5 完了）"
