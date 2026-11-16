import 'dart:convert';

import 'package:amplify_auth_cognito/amplify_auth_cognito.dart';
import 'package:amplify_flutter/amplify_flutter.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;

import 'auth_service.dart';

/// Amplify（Cognito）を使った認証。
///
/// このクラスは Cognito との通信そのものなので、単体テストでは動かさない
/// （画面と状態管理のテストは、[AuthService] の代用品で行う）。
class AmplifyAuthService implements AuthService {
  AmplifyAuthCognito get _cognito =>
      Amplify.Auth.getPlugin(AmplifyAuthCognito.pluginKey);

  @override
  Future<void> initialize(AuthSettings config) async {
    if (Amplify.isConfigured) return;
    await Amplify.addPlugin(AmplifyAuthCognito());
    await Amplify.configure(
      jsonEncode({
        'UserAgent': 'aws-amplify-cli/2.0',
        'Version': '1.0',
        'auth': {
          'plugins': {
            'awsCognitoAuthPlugin': {
              'CognitoUserPool': {
                'Default': {
                  'PoolId': config.userPoolId,
                  'AppClientId': config.webClientId,
                  'Region': config.region,
                },
              },
              'Auth': {
                'Default': {'authenticationFlowType': 'USER_SRP_AUTH'},
              },
            },
          },
        },
      }),
    );
  }

  @override
  Future<bool> isSignedIn() =>
      _guard(() async => (await _cognito.fetchAuthSession()).isSignedIn);

  @override
  Future<String?> getAccessToken() => _guard(() async {
    // 期限が近いトークンは、ここでリフレッシュトークンを使って更新される
    final session = await _cognito.fetchAuthSession();
    try {
      return session.userPoolTokensResult.value.accessToken.raw;
    } on SignedOutException {
      return null;
    } on SessionExpiredException {
      // リフレッシュトークンの期限切れ・取り消し。Amplify が端末のログイン情報を消している
      return null;
    }
    // それ以外（通信できない・Cognito の一時的な失敗）は _guard が AuthFailure にする
  });

  @override
  Future<void> signUp({required String email, required String password}) =>
      _guard(() async {
        await Amplify.Auth.signUp(
          username: email,
          password: password,
          options: SignUpOptions(
            userAttributes: {AuthUserAttributeKey.email: email},
          ),
        );
      });

  @override
  Future<void> confirmSignUp({required String email, required String code}) =>
      _guard(() async {
        await Amplify.Auth.confirmSignUp(
          username: email,
          confirmationCode: code,
        );
      });

  @override
  Future<void> resendSignUpCode({required String email}) => _guard(() async {
    await Amplify.Auth.resendSignUpCode(username: email);
  });

  @override
  Future<SignInOutcome> signIn({
    required String email,
    required String password,
  }) => _guard(() async {
    try {
      final result = await Amplify.Auth.signIn(
        username: email,
        password: password,
      );
      if (result.isSignedIn) return SignInOutcome.signedIn;
      if (result.nextStep.signInStep == AuthSignInStep.confirmSignUp) {
        return SignInOutcome.confirmationRequired;
      }
      if (result.nextStep.signInStep == AuthSignInStep.resetPassword) {
        // 管理者がパスワードをリセットした利用者
        throw const AuthFailure(AuthFailureKind.passwordResetRequired);
      }
      // 多要素認証などは使わない設定なので、ここには来ない
      throw const AuthFailure(AuthFailureKind.unknown);
    } on UserNotConfirmedException {
      return SignInOutcome.confirmationRequired;
    }
  });

  @override
  Future<void> signOut() => _guard(() async {
    await Amplify.Auth.signOut();
  });

  @override
  Future<void> requestPasswordReset({required String email}) =>
      _guard(() async {
        await Amplify.Auth.resetPassword(username: email);
      });

  @override
  Future<void> confirmPasswordReset({
    required String email,
    required String code,
    required String newPassword,
  }) => _guard(() async {
    await Amplify.Auth.confirmResetPassword(
      username: email,
      newPassword: newPassword,
      confirmationCode: code,
    );
  });
}

/// Amplify の例外を [AuthFailure] にそろえる。
Future<T> _guard<T>(Future<T> Function() action) async {
  try {
    return await action();
  } on AuthFailure {
    rethrow;
  } on Object catch (error) {
    throw AuthFailure(authFailureKindOf(error));
  }
}

/// Amplify の例外が、どの種類の失敗にあたるか。
@visibleForTesting
AuthFailureKind authFailureKindOf(Object error) => switch (error) {
  // 未登録のメールアドレスも、Cognito の設定（存在を教えない）によりここに来る
  AuthNotAuthorizedException() ||
  UserNotFoundException() => AuthFailureKind.invalidCredentials,
  UsernameExistsException() => AuthFailureKind.emailAlreadyUsed,
  InvalidPasswordException() => AuthFailureKind.invalidPassword,
  CodeMismatchException() => AuthFailureKind.codeMismatch,
  ExpiredCodeException() => AuthFailureKind.codeExpired,
  LimitExceededException() ||
  TooManyRequestsException() ||
  TooManyFailedAttemptsException() => AuthFailureKind.tooManyAttempts,
  NetworkException() => AuthFailureKind.network,
  _ => AuthFailureKind.unknown,
};
