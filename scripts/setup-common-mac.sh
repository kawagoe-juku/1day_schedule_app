# setup-*-mac.sh の共通部分（表示用の関数・macOS の確認・PATH の追記）。source して使う。
ok()   { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[注意]\033[0m %s\n' "$*"; }
ng()   { printf '\033[31m[NG]\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
add_path() { # $1: ディレクトリ。~/.zshrc に1回だけ追記し、このシェルにも反映
  export PATH="$1:$PATH"
  local line="export PATH=\"$1:\$PATH\""
  grep -qF "$line" "$HOME/.zshrc" 2>/dev/null || { echo "$line" >> "$HOME/.zshrc"; ok "~/.zshrc に PATH を追記：$1"; }
}

[[ "$(uname -s)" == "Darwin" ]] || { ng "macOS で実行してください"; exit 1; }
ok "macOS $(sw_vers -productVersion)（$(uname -m)）"
