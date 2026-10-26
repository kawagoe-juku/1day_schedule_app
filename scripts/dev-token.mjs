// 開発環境の Cognito に SRP 方式でログインし、アクセストークンを標準出力に出す（API の動作確認用）。
// 画面（Flutter / Amplify）と同じ方式なので、Web 用クライアントの設定を変えずに使える。
//   使い方：TOKEN=$(npm run -s dev:token -- you@example.com)
//          curl -H "Authorization: Bearer $TOKEN" https://dev.super-ai-schedule-app.com/api/session
// 接続先は server/.env の COGNITO_USER_POOL_ID・COGNITO_WEB_CLIENT_ID（環境変数でも指定できる）。
// パスワードは画面に表示せずに入力する（または環境変数 DEV_TOKEN_PASSWORD）。トークン以外は標準エラーに出す。
import cognito from 'amazon-cognito-identity-js';
import { createInterface } from 'node:readline';

const { AuthenticationDetails, CognitoUser, CognitoUserPool } = cognito;

try {
  process.loadEnvFile(new URL('../server/.env', import.meta.url));
} catch {
  // server/.env がなければ環境変数だけを使う
}
const { COGNITO_USER_POOL_ID: UserPoolId, COGNITO_WEB_CLIENT_ID: ClientId } = process.env;
const email = process.argv[2];
if (!UserPoolId || !ClientId || !email) {
  console.error('使い方：npm run -s dev:token -- <メールアドレス>');
  console.error('server/.env に COGNITO_USER_POOL_ID・COGNITO_WEB_CLIENT_ID を設定してください');
  process.exit(1);
}

/** 入力を画面に表示せずにパスワードを読む */
function readPassword(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(prompt)) process.stderr.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

// 環境変数 DEV_TOKEN_PASSWORD があればそれを使う（対話なしで実行する場合）
const password = process.env.DEV_TOKEN_PASSWORD || (await readPassword('パスワード: '));
const user = new CognitoUser({
  Username: email,
  Pool: new CognitoUserPool({ UserPoolId, ClientId }),
});
user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
  onSuccess: (session) => {
    process.stdout.write(`${session.getAccessToken().getJwtToken()}\n`);
  },
  onFailure: (err) => {
    console.error(`ログインできませんでした：${err.name ?? ''} ${err.message ?? err}`);
    process.exit(1);
  },
  // 管理者が作成した直後の利用者（仮パスワード）。画面から一度ログインしてパスワードを設定する
  newPasswordRequired: () => {
    console.error('ログインできませんでした：初回ログイン時のパスワード変更が済んでいません');
    process.exit(1);
  },
});
