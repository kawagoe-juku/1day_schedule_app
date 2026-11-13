import 'package:ai_schedule_app/auth/auth_service.dart';
import 'package:ai_schedule_app/auth/session_controller.dart';
import 'package:ai_schedule_app/routing/app_router.dart';
import 'package:ai_schedule_app/widgets/app_frame.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers.dart';
import 'fake_auth_service.dart';

const _newEmail = 'new@example.com';

/// 未ログインで起動する（登録済みの利用者が1人いる）。
Future<TestEnvironment> _pumpSignedOut(
  WidgetTester tester, {
  bool onboardingCompleted = true,
}) => pumpApp(
  tester,
  env: TestEnvironment()
    ..addUser()
    ..onboardingCompleted = onboardingCompleted,
);

Future<void> _selectTab(WidgetTester tester, String label) async {
  await tester.tap(find.text(label).first);
  await tester.pumpAndSettle();
}

Future<void> _fill(WidgetTester tester, String email, String password) async {
  await enter(tester, 'auth-email', email);
  await enter(tester, 'auth-password', password);
}

void main() {
  group('未ログイン時の画面制御', () {
    testWidgets('未ログインならログイン画面を出す', (tester) async {
      final env = await _pumpSignedOut(tester);

      expectScreen('ログイン');
      expect(env.auth.settings?.userPoolId, 'ap-northeast-1_TestPool1');
    });

    testWidgets('未ログインでほかの画面を開こうとしても、ログイン画面になる', (tester) async {
      await _pumpSignedOut(tester);

      ProviderScope.containerOf(tester.element(find.byType(AppFrame)))
          .read(routerProvider)
          .go(AppRoutes.routines);
      await tester.pumpAndSettle();

      expectScreen('ログイン');
    });

    test('行き先の決め方', () {
      const signedOut = SessionSignedOut();
      const onboarding = SessionSignedIn(onboardingCompleted: false);
      const ready = SessionSignedIn(onboardingCompleted: true);

      expect(redirectFor(signedOut, '/'), '/login');
      expect(redirectFor(signedOut, '/login'), isNull);
      expect(redirectFor(const SessionLoading(), '/memos'), '/login');
      expect(redirectFor(const SessionUnavailable(), '/'), '/login');
      expect(redirectFor(onboarding, '/'), '/onboarding');
      expect(redirectFor(onboarding, '/login'), '/onboarding');
      expect(redirectFor(onboarding, '/onboarding'), isNull);
      expect(redirectFor(ready, '/login'), '/');
      expect(redirectFor(ready, '/onboarding'), '/');
      expect(redirectFor(ready, '/settings/profile'), isNull);
    });
  });

  group('サインイン', () {
    testWidgets('IT-010 初回設定が済んでいればホームへ進み、API に JWT が付く', (tester) async {
      final env = await _pumpSignedOut(tester);

      await _fill(tester, testEmail, testPassword);
      await tapKey(tester, 'auth-submit');

      expectScreen('ホーム');
      final profileRequest = env.server.requests.lastWhere(
        (request) => request.uri.path == '/api/profile',
      );
      expect(
        profileRequest.headers['Authorization'],
        'Bearer token-$testEmail',
      );
    });

    testWidgets('IT-011 初回設定が済んでいなければ初回設定へ進む', (tester) async {
      await _pumpSignedOut(tester, onboardingCompleted: false);

      await _fill(tester, testEmail, testPassword);
      await tapKey(tester, 'auth-submit');

      expectScreen('初回設定');
    });

    testWidgets('IT-012・013 パスワード誤り・未登録メールは入力欄の下にエラーを出し、何度でもやり直せる', (
      tester,
    ) async {
      final env = await _pumpSignedOut(tester);

      for (var i = 0; i < 6; i++) {
        await _fill(tester, testEmail, 'WrongPassword1');
        await tapKey(tester, 'auth-submit');
        expect(find.text('メールアドレスまたはパスワードが正しくありません'), findsOneWidget);
      }
      await _fill(tester, 'nobody@example.com', testPassword);
      await tapKey(tester, 'auth-submit');
      expect(find.text('メールアドレスまたはパスワードが正しくありません'), findsOneWidget);
      expectScreen('ログイン');

      await _fill(tester, testEmail, testPassword);
      await tapKey(tester, 'auth-submit');
      expectScreen('ホーム');
      expect(env.auth.calls.where((c) => c.startsWith('signIn')), hasLength(8));
    });

    testWidgets('IT-009 未入力・メール形式の誤りは、通信せずにその場でエラーにする', (tester) async {
      final env = await _pumpSignedOut(tester);

      await tapKey(tester, 'auth-submit');
      expect(find.text('メールアドレスを入力してください'), findsOneWidget);
      expect(find.text('パスワードを入力してください'), findsOneWidget);

      for (final email in ['user@', 'userexample.com']) {
        await _fill(tester, email, testPassword);
        await tapKey(tester, 'auth-submit');
        expect(find.text('メールアドレスの形式が正しくありません'), findsOneWidget);
      }
      expect(env.auth.calls, isEmpty);
    });

    testWidgets('IT-014 確認コードが未入力の利用者は、コードの入力へ進み、確認後にログインできる', (tester) async {
      final env = TestEnvironment()..onboardingCompleted = false;
      env.auth.addUser(_newEmail, testPassword, confirmed: false);
      await pumpApp(tester, env: env);

      await _fill(tester, _newEmail, testPassword);
      await tapKey(tester, 'auth-submit');
      expect(find.byKey(const Key('auth-code')), findsOneWidget);

      await enter(tester, 'auth-code', FakeAuthService.validCode);
      await tapKey(tester, 'auth-submit');
      expectScreen('初回設定');
    });

    testWidgets('IT-015 タブで入力フォームとボタンの表記が切り替わる', (tester) async {
      await _pumpSignedOut(tester);

      expect(find.widgetWithText(FilledButton, 'サインイン'), findsOneWidget);
      expect(find.text('パスワードを忘れた場合'), findsOneWidget);

      await _selectTab(tester, 'サインアップ');
      expect(find.widgetWithText(FilledButton, 'サインアップ'), findsOneWidget);
      expect(find.text('パスワードを忘れた場合'), findsNothing);

      await _selectTab(tester, 'サインイン');
      expect(find.widgetWithText(FilledButton, 'サインイン'), findsOneWidget);
    });
  });

  group('サインアップ', () {
    Future<TestEnvironment> start(WidgetTester tester) async {
      final env = await _pumpSignedOut(tester, onboardingCompleted: false);
      await _selectTab(tester, 'サインアップ');
      return env;
    }

    testWidgets('IT-001・002 サインアップすると確認コードの欄が出て、正しいコードで初回設定へ進む', (
      tester,
    ) async {
      final env = await start(tester);

      await _fill(tester, _newEmail, testPassword);
      await tapKey(tester, 'auth-submit');
      expect(find.byKey(const Key('auth-code')), findsOneWidget);
      expect(env.auth.users[_newEmail]?.confirmed, isFalse);

      await enter(tester, 'auth-code', FakeAuthService.validCode);
      await tapKey(tester, 'auth-submit');

      expect(env.auth.users[_newEmail]?.confirmed, isTrue);
      expectScreen('初回設定');
    });

    testWidgets('IT-003 確認コードが違えば、欄の下にエラーを出し、有効にしない', (tester) async {
      final env = await start(tester);
      await _fill(tester, _newEmail, testPassword);
      await tapKey(tester, 'auth-submit');

      await enter(tester, 'auth-code', '000000');
      await tapKey(tester, 'auth-submit');

      expect(find.text('確認コードが正しくありません'), findsOneWidget);
      expect(env.auth.users[_newEmail]?.confirmed, isFalse);
      expectScreen('ログイン');
    });

    testWidgets('IT-004 期限切れのコードはエラーにし、再送したコードで有効にできる', (tester) async {
      final env = await start(tester);
      await _fill(tester, _newEmail, testPassword);
      await tapKey(tester, 'auth-submit');

      env.auth.failNext = AuthFailureKind.codeExpired;
      await enter(tester, 'auth-code', FakeAuthService.validCode);
      await tapKey(tester, 'auth-submit');
      expect(find.textContaining('有効期限が切れています'), findsOneWidget);

      await tester.tap(find.text('確認コードを再送'));
      await tester.pumpAndSettle();
      expect(env.auth.calls, contains('resendSignUpCode:$_newEmail'));
      expect(find.text('確認コードを送り直しました'), findsOneWidget);

      await tapKey(tester, 'auth-submit');
      expectScreen('初回設定');
    });

    testWidgets('IT-005 確認コードの形式が違えば、通信せずにエラーにする', (tester) async {
      final env = await start(tester);
      await _fill(tester, _newEmail, testPassword);
      await tapKey(tester, 'auth-submit');

      for (final code in ['12345', '12a456']) {
        await enter(tester, 'auth-code', code);
        await tapKey(tester, 'auth-submit');
        expect(find.text('確認コードは6桁の数字で入力してください'), findsOneWidget);
      }
      expect(
        env.auth.calls.where((c) => c.startsWith('confirmSignUp')),
        isEmpty,
      );
    });

    testWidgets('IT-006 登録済みのメールアドレスは、メールアドレスの下にエラーを出す', (tester) async {
      await start(tester);

      await _fill(tester, testEmail, 'Another1Password');
      await tapKey(tester, 'auth-submit');

      expect(find.text('このメールアドレスは登録済みです'), findsOneWidget);
      expect(find.byKey(const Key('auth-code')), findsNothing);
    });

    testWidgets('IT-007・008 パスワードが決まりを満たさなければ、通信せずにエラーにする', (tester) async {
      final env = await start(tester);

      // 7文字／大文字なし／数字なし
      for (final password in ['Abcde1x', 'password1', 'Passwordx']) {
        await _fill(tester, _newEmail, password);
        await tapKey(tester, 'auth-submit');
        expect(
          find.text(passwordPolicyMessage),
          findsOneWidget,
          reason: password,
        );
      }
      expect(env.auth.calls, isEmpty);
    });
  });

  group('パスワードリセット', () {
    Future<TestEnvironment> open(WidgetTester tester) async {
      final env = await _pumpSignedOut(tester);
      await tester.tap(find.text('パスワードを忘れた場合'));
      await tester.pumpAndSettle();
      return env;
    }

    testWidgets('IT-020・024・026 3ステップで完了し、新しいパスワードだけでログインできる', (tester) async {
      final env = await open(tester);
      expect(find.text('パスワードリセット'), findsOneWidget);
      expect(find.text('ステップ 1/3'), findsOneWidget);

      await enter(tester, 'reset-email', testEmail);
      await tapKey(tester, 'reset-next');
      expect(env.auth.calls, contains('requestPasswordReset:$testEmail'));
      expect(find.text('ステップ 2/3'), findsOneWidget);

      await enter(tester, 'reset-code', FakeAuthService.validCode);
      await tapKey(tester, 'reset-next');
      expect(find.text('ステップ 3/3'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, '完了'), findsOneWidget);

      await enter(tester, 'reset-password', 'NewPassword2');
      await tapKey(tester, 'reset-next');

      expect(find.text('パスワードリセット'), findsNothing);
      expectScreen('ログイン');

      await _fill(tester, testEmail, testPassword);
      await tapKey(tester, 'auth-submit');
      expect(find.text('メールアドレスまたはパスワードが正しくありません'), findsOneWidget);

      await _fill(tester, testEmail, 'NewPassword2');
      await tapKey(tester, 'auth-submit');
      expectScreen('ホーム');
    });

    testWidgets('IT-021 メール形式が違えば、ステップ2へ進まない', (tester) async {
      final env = await open(tester);

      await enter(tester, 'reset-email', 'user@');
      await tapKey(tester, 'reset-next');

      expect(find.text('メールアドレスの形式が正しくありません'), findsOneWidget);
      expect(find.text('ステップ 1/3'), findsOneWidget);
      expect(env.auth.calls, isEmpty);
    });

    testWidgets('IT-022 確認コードが違えば、エラーを出してパスワードを変えない', (tester) async {
      final env = await open(tester);
      await enter(tester, 'reset-email', testEmail);
      await tapKey(tester, 'reset-next');
      await enter(tester, 'reset-code', '000000');
      await tapKey(tester, 'reset-next');
      await enter(tester, 'reset-password', 'NewPassword2');
      await tapKey(tester, 'reset-next');

      expect(find.text('確認コードが正しくありません'), findsOneWidget);
      expect(find.text('ステップ 2/3'), findsOneWidget);
      expect(env.auth.users[testEmail]?.password, testPassword);
    });

    testWidgets('IT-023 新しいパスワードが決まりを満たさなければ、完了しない', (tester) async {
      final env = await open(tester);
      await enter(tester, 'reset-email', testEmail);
      await tapKey(tester, 'reset-next');
      await enter(tester, 'reset-code', FakeAuthService.validCode);
      await tapKey(tester, 'reset-next');

      await enter(tester, 'reset-password', 'Abcde1x');
      await tapKey(tester, 'reset-next');

      expect(find.text(passwordPolicyMessage), findsOneWidget);
      expect(find.text('ステップ 3/3'), findsOneWidget);
      expect(
        env.auth.calls.where((c) => c.startsWith('confirmPasswordReset')),
        isEmpty,
      );
    });

    testWidgets('IT-025 どのステップでもキャンセルで閉じ、パスワードは変わらない', (tester) async {
      for (var step = 1; step <= 3; step++) {
        final env = await open(tester);
        if (step >= 2) {
          await enter(tester, 'reset-email', testEmail);
          await tapKey(tester, 'reset-next');
        }
        if (step >= 3) {
          await enter(tester, 'reset-code', FakeAuthService.validCode);
          await tapKey(tester, 'reset-next');
        }
        expect(find.text('ステップ $step/3'), findsOneWidget);

        await tester.tap(find.text('キャンセル'));
        await tester.pumpAndSettle();

        expect(find.text('パスワードリセット'), findsNothing);
        expectScreen('ログイン');
        expect(env.auth.users[testEmail]?.password, testPassword);
      }
    });
  });

  group('セッション', () {
    testWidgets('IT-018 ログイン情報が残っていれば、再ログインなしでホームを出す', (tester) async {
      final env = await pumpApp(tester);

      expectScreen('ホーム');
      expect(env.auth.calls, isEmpty);
    });

    testWidgets('IT-017 無操作のまま24時間たっていたら、起動時にログアウトしてログイン画面を出す', (tester) async {
      final env = TestEnvironment()..addUser(signedIn: true);
      env.activity.value = env.now.subtract(sessionIdleTimeout);
      await pumpApp(tester, env: env);

      expectScreen('ログイン');
      expect(env.auth.signedInEmail, isNull);
    });

    testWidgets('IT-017 画面を開いたまま24時間たつと、次の API 呼び出しの前にログアウトする', (tester) async {
      final env = await pumpApp(tester);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(AppFrame)),
      );

      env.now = env.now.add(const Duration(hours: 23, minutes: 59));
      expect(
        await container
            .read(sessionControllerProvider.notifier)
            .getAccessToken(),
        isNotNull,
      );

      env.now = env.now.add(sessionIdleTimeout);
      expect(
        await container
            .read(sessionControllerProvider.notifier)
            .getAccessToken(),
        isNull,
      );
      await tester.pumpAndSettle();
      expectScreen('ログイン');
    });

    testWidgets('設定を取得できなければ「取得に失敗しました」を出し、再試行できる', (tester) async {
      final env = TestEnvironment()
        ..addUser(signedIn: true)
        ..configUnavailable = true;
      await pumpApp(tester, env: env);

      expectScreen('ログイン');
      expect(find.text('取得に失敗しました'), findsOneWidget);

      env.configUnavailable = false;
      await tester.tap(find.text('再試行'));
      await tester.pumpAndSettle();
      expectScreen('ホーム');
    });

    testWidgets('ログアウトするとログイン画面へ戻る', (tester) async {
      final env = await pumpApp(tester);

      await tapButton(tester, '設定');
      await tapButton(tester, 'ログアウト');

      expectScreen('ログイン');
      expect(env.auth.signedInEmail, isNull);
      expect(env.activity.value, isNull);
    });
  });
}
