import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AuthStack } from '../lib/auth-stack.js';
import { STAGES } from '../lib/config.js';

const synth = (stage: keyof typeof STAGES) =>
  Template.fromStack(
    new AuthStack(new App(), `Test-${stage}-Auth`, {
      config: STAGES[stage],
      env: { account: '123456789012', region: 'ap-northeast-1' },
    }),
  );

describe('AuthStack', () => {
  it('メールアドレスでサインインし、パスワードは8文字以上・大小英字・数字', () => {
    synth('dev').hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
      AutoVerifiedAttributes: ['email'],
      UsernameConfiguration: { CaseSensitive: false },
      Policies: {
        PasswordPolicy: Match.objectLike({
          MinimumLength: 8,
          RequireLowercase: true,
          RequireUppercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
        }),
      },
      AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'verified_email', Priority: 1 }] },
      EmailConfiguration: { EmailSendingAccount: 'COGNITO_DEFAULT' },
      UserPoolTier: 'ESSENTIALS',
      UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
    });
  });

  it('Web 用クライアントはシークレットなし・SRP・トークン取り消し有効・リフレッシュ1日', () => {
    const t = synth('dev');
    const [client] = Object.values(t.findResources('AWS::Cognito::UserPoolClient')) as {
      Properties: {
        ExplicitAuthFlows: string[];
        CallbackURLs?: unknown;
        AllowedOAuthFlowsUserPoolClient?: boolean;
      };
    }[];
    // SRP とトークン更新以外の認証方式（パスワードの平文送信など）を許可していない
    expect([...client!.Properties.ExplicitAuthFlows].sort()).toEqual([
      'ALLOW_REFRESH_TOKEN_AUTH',
      'ALLOW_USER_SRP_AUTH',
    ]);
    expect(client!.Properties.CallbackURLs).toBeUndefined();
    expect(client!.Properties.AllowedOAuthFlowsUserPoolClient ?? false).toBe(false);
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      PreventUserExistenceErrors: 'ENABLED',
      EnableTokenRevocation: true,
      AccessTokenValidity: 60,
      IdTokenValidity: 60,
      RefreshTokenValidity: 1440,
      TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'minutes' },
    });
  });

  it('dev は削除可能、stg・prod は削除保護あり', () => {
    synth('dev').hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Delete' });
    for (const stage of ['stg', 'prod'] as const) {
      const t = synth(stage);
      t.hasResource('AWS::Cognito::UserPool', { DeletionPolicy: 'Retain' });
      t.hasResourceProperties('AWS::Cognito::UserPool', { DeletionProtection: 'ACTIVE' });
    }
  });

  it('ID を SSM パラメータに保存する', () => {
    const names = Object.values(synth('dev').findResources('AWS::SSM::Parameter')).map(
      (r) => (r as { Properties: { Name: string } }).Properties.Name,
    );
    expect(names.sort()).toEqual([
      '/schedule-app/dev/auth/user-pool-id',
      '/schedule-app/dev/auth/web-client-id',
    ]);
  });
});
