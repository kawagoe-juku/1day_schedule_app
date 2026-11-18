import 'package:ai_schedule_app/auth/amplify_auth_service.dart';
import 'package:ai_schedule_app/auth/auth_service.dart';
import 'package:amplify_auth_cognito/amplify_auth_cognito.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Amplify の例外を、画面で使う失敗の種類に対応させる', () {
    const cases = <(Object, AuthFailureKind)>[
      (AuthNotAuthorizedException('x'), AuthFailureKind.invalidCredentials),
      (UserNotFoundException('x'), AuthFailureKind.invalidCredentials),
      (UsernameExistsException('x'), AuthFailureKind.emailAlreadyUsed),
      (InvalidPasswordException('x'), AuthFailureKind.invalidPassword),
      (CodeMismatchException('x'), AuthFailureKind.codeMismatch),
      (ExpiredCodeException('x'), AuthFailureKind.codeExpired),
      (LimitExceededException('x'), AuthFailureKind.tooManyAttempts),
      (TooManyRequestsException('x'), AuthFailureKind.tooManyAttempts),
      (TooManyFailedAttemptsException('x'), AuthFailureKind.tooManyAttempts),
      (NetworkException('x'), AuthFailureKind.network),
      (UnknownException('x'), AuthFailureKind.unknown),
    ];
    for (final (error, kind) in cases) {
      expect(authFailureKindOf(error), kind, reason: '${error.runtimeType}');
    }
    expect(authFailureKindOf(StateError('x')), AuthFailureKind.unknown);
  });

  test('失敗の種類ごとに、利用者向けの日本語のメッセージがある', () {
    for (final kind in AuthFailureKind.values) {
      expect(AuthFailure(kind).message, matches(RegExp('[ぁ-ん]')));
    }
  });
}
