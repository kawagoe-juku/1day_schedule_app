import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  FeaturePlan,
  UserPool,
  UserPoolEmail,
  VerificationEmailStyle,
  type UserPoolClient,
} from 'aws-cdk-lib/aws-cognito';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { removalPolicyOf } from './common.js';
import { PROJECT, ssmPath, type StageConfig } from './config.js';

/**
 * セッションの有効期間。要件「無操作1日でセッション終了」は、Cognito では
 * リフレッシュトークンの有効期間（発行から1日）で代用する（要件定義からの差分。API 仕様に記載）。
 */
const SESSION = {
  accessAndIdTokenHours: 1,
  refreshTokenDays: 1,
} as const;

export interface AuthStackProps extends StackProps {
  readonly config: StageConfig;
}

/**
 * Cognito User Pool と Web 用 App Client（要件定義書 3.3.1）。
 *
 * - メールアドレス＋パスワード。パスワードは8文字以上・大文字・小文字・数字。
 * - ログイン失敗によるロックは設けない（Cognito 標準の一時停止は無効化できないため受け入れる。要件定義からの差分）。
 * - 確認コードのメールは Cognito 標準の送信機能を使う（送信数の上限が足りなくなれば SES に切り替える）。
 * - ID はサーバ（JWT 検証）と Flutter のビルド設定から使うため SSM パラメータに保存する。
 */
export class AuthStack extends Stack {
  readonly userPool: UserPool;
  readonly webClient: UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { stage, retainOnDelete } = props.config;

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `${PROJECT}-${stage}-users`,
      featurePlan: FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      // メールアドレスを変更しても、新しいアドレスの確認が済むまでは元のアドレスでログインできるようにする
      keepOriginal: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      email: UserPoolEmail.withCognito(),
      userVerification: {
        emailStyle: VerificationEmailStyle.CODE,
        emailSubject: '【AIスケジュール外出支援】確認コードのお知らせ',
        emailBody: '確認コードは {####} です。アプリの画面に入力してください。',
      },
      deletionProtection: retainOnDelete,
      removalPolicy: removalPolicyOf(retainOnDelete),
    });

    this.webClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${PROJECT}-${stage}-web`,
      generateSecret: false, // ブラウザから使うためシークレットを持たない
      authFlows: { userSrp: true },
      disableOAuth: true, // ホスト型のログイン画面は使わない（画面は Flutter で作る）
      preventUserExistenceErrors: true,
      // リフレッシュトークンの取り消し（ログアウト）を有効にする。全端末ログアウトは GlobalSignOut で行う。
      // どちらの場合も、発行済みのアクセストークンは有効期限（1時間）まではサーバの JWT 検証を通る。
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(SESSION.accessAndIdTokenHours),
      idTokenValidity: Duration.hours(SESSION.accessAndIdTokenHours),
      refreshTokenValidity: Duration.days(SESSION.refreshTokenDays),
    });

    new StringParameter(this, 'UserPoolIdParam', {
      parameterName: ssmPath(stage, 'auth/user-pool-id'),
      stringValue: this.userPool.userPoolId,
      description: 'Cognito User Pool ID（サーバの JWT 検証・Flutter のビルド設定で使用）',
    });
    new StringParameter(this, 'WebClientIdParam', {
      parameterName: ssmPath(stage, 'auth/web-client-id'),
      stringValue: this.webClient.userPoolClientId,
      description: 'Cognito App Client ID（Web 用）',
    });
  }
}
