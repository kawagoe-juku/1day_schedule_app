# 開発端末のセットアップ（macOS）

WBS 1.2 の手順書。上から順に実施する。

## 1. Homebrew

未導入の場合は <https://brew.sh/ja/> の手順でインストールする。

## 2. Node.js 22

```bash
brew install nvm
mkdir -p ~/.nvm
# 表示される案内に従い ~/.zshrc に nvm の設定を追記してから、ターミナルを開き直す
cd <このリポジトリ>
nvm install    # .nvmrc の 22 をインストール
nvm use
node -v        # v22.x.x
```

## 3. Docker Desktop

<https://www.docker.com/products/docker-desktop/> からインストールし、起動しておく。

```bash
docker compose version
```

## 4. Flutter SDK（Web）

リポジトリ直下で `npm run app:setup`（= `bash scripts/setup-flutter-mac.sh`）を実行すると、以下のインストールから `app/` のプロジェクト作成・動作確認までを一度に行う。手動で行う場合は次のとおり。

```bash
brew install --cask flutter
flutter config --enable-web
flutter doctor
```

`flutter doctor` で「Chrome - develop for the web」と「Flutter」にチェックが付いていればよい。Xcode・Android Studio の警告は Web版では無視してよい。

## 5. AWS CLI と AWS CDK

リポジトリ直下で `npm run tools:setup`（= `bash scripts/setup-tools-mac.sh`）を実行すると、AWS CLI と CDK を管理者権限なしでユーザー領域に入れ、Docker の状況も確認する。手動で行う場合は次のとおり。

```bash
brew install awscli
npm install -g aws-cdk
aws --version
cdk --version
```

## 6. AWS の認証情報（WBS 1.3 で用意したもの）

ユーザーの分け方と cdk bootstrap の手順は [`aws-account.md`](aws-account.md) を参照。

```bash
aws configure --profile schedule-app-dev
# リージョンは ap-northeast-1
aws sts get-caller-identity --profile schedule-app-dev
```

## 完了の確認（WBS 1.2 の完了基準）

- [ ] `flutter doctor` で Web のチェックがすべて OK
- [ ] `aws sts get-caller-identity --profile schedule-app-dev` が開発用アカウントで成功する
- [ ] `cdk --version` が実行できる
- [ ] リポジトリで `npm install` → `npm test` が通る
