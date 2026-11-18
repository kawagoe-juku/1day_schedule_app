import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../auth/session_controller.dart';
import '../screens/home_screen.dart';
import '../screens/login_screen.dart';
import '../screens/memos_screen.dart';
import '../screens/not_found_screen.dart';
import '../screens/onboarding_screen.dart';
import '../screens/plan_result_screen.dart';
import '../screens/profile_edit_screen.dart';
import '../screens/routines_screen.dart';
import '../screens/settings_screen.dart';

/// 画面のパス。画面の見本（docs/Alli/紙芝居html/HTML_0831/）の 2.2.1〜2.2.7 に対応する。
abstract final class AppRoutes {
  /// 2.2.2 ホーム／入力
  static const home = '/';

  /// 2.2.1 ログイン（サインイン・サインアップ・パスワードリセット）
  static const login = '/login';

  /// 2.2.1 初回オンボーディング
  static const onboarding = '/onboarding';

  /// 2.2.4 ルーティン設定
  static const routines = '/routines';

  /// 2.2.5 メモ・買い物リスト
  static const memos = '/memos';

  /// 2.2.6 アカウント・設定
  static const settings = '/settings';

  /// 2.2.7 プロファイル編集
  static const profileEdit = '/settings/profile';

  /// 2.2.3 行動計画結果
  static String planResult(String planId) =>
      '/plans/${Uri.encodeComponent(planId)}';
}

/// ログイン後に戻る先を入れておくクエリの名前（例：`/login?from=%2Fmemos`）。
const fromQueryKey = 'from';

/// ログイン後に戻る先として使ってよいパスか。
///
/// アプリの中のパス（`/` で始まる）だけを通す。`//example.com` や `https://…` のような
/// 外部の URL と、戻る意味のないログイン画面・初回設定は通さない。
bool _isReturnable(String? location) {
  if (location == null ||
      !location.startsWith('/') ||
      location.startsWith('//')) {
    return false;
  }
  final path = Uri.tryParse(location)?.path;
  return path != null &&
      path != AppRoutes.login &&
      path != AppRoutes.onboarding;
}

/// [path] へ送る。[returnTo] が戻る先として使えるなら、クエリに付けて覚えておく。
String _withFrom(String path, String? returnTo) => _isReturnable(returnTo)
    ? Uri(path: path, queryParameters: {fromQueryKey: returnTo}).toString()
    : path;

/// ログインの状態から、開こうとしている場所（[location]）の行き先を決める。null なら、そのまま開く。
///
/// - 未ログイン（状態の確認中・確認できないときを含む）：ログイン画面へ
/// - ログイン済みで初回設定が済んでいない：初回設定へ
/// - ログイン済みで初回設定も済んでいる：ログイン画面・初回設定を開こうとしたら、
///   元の場所（無ければホーム）へ
///
/// ログイン画面・初回設定へ送るときは、元の場所をクエリ（[fromQueryKey]）に覚えておく。
/// ログイン済みで画面を再読み込みしたときも、状態の確認が終われば元の場所に戻る。
String? redirectFor(SessionState session, Uri location) {
  final path = location.path;
  // すでに覚えている戻り先があればそれを引き継ぎ、無ければ今の場所を戻り先にする
  final returnTo =
      location.queryParameters[fromQueryKey] ?? location.toString();

  switch (session) {
    case SessionSignedIn(onboardingCompleted: true):
      if (path != AppRoutes.login && path != AppRoutes.onboarding) return null;
      final from = location.queryParameters[fromQueryKey];
      return _isReturnable(from) ? from : AppRoutes.home;
    case SessionSignedIn():
      return path == AppRoutes.onboarding
          ? null
          : _withFrom(AppRoutes.onboarding, returnTo);
    default:
      return path == AppRoutes.login
          ? null
          : _withFrom(AppRoutes.login, returnTo);
  }
}

/// 起動時に開く場所。ブラウザでは URL が優先されるので、テストで「再読み込み」をまねるために使う。
final initialLocationProvider = Provider<String>((ref) => AppRoutes.home);

/// 画面遷移の定義。
final routerProvider = Provider<GoRouter>((ref) {
  // ログインの状態が変わったら、行き先を決め直す
  final sessionChanged = ValueNotifier(0);
  ref
    ..listen(sessionControllerProvider, (_, _) => sessionChanged.value++)
    ..onDispose(sessionChanged.dispose);

  final router = GoRouter(
    initialLocation: ref.watch(initialLocationProvider),
    refreshListenable: sessionChanged,
    redirect: (context, state) =>
        redirectFor(ref.read(sessionControllerProvider), state.uri),
    errorBuilder: (context, state) => const NotFoundScreen(),
    routes: [
      GoRoute(
        path: AppRoutes.home,
        builder: (context, state) => const HomeScreen(),
      ),
      GoRoute(
        path: AppRoutes.login,
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: AppRoutes.onboarding,
        builder: (context, state) => const OnboardingScreen(),
      ),
      GoRoute(
        path: '/plans/:planId',
        builder: (context, state) =>
            PlanResultScreen(planId: state.pathParameters['planId']!),
      ),
      GoRoute(
        path: AppRoutes.routines,
        builder: (context, state) => const RoutinesScreen(),
      ),
      GoRoute(
        path: AppRoutes.memos,
        builder: (context, state) => const MemosScreen(),
      ),
      GoRoute(
        path: AppRoutes.settings,
        builder: (context, state) => const SettingsScreen(),
      ),
      GoRoute(
        path: AppRoutes.profileEdit,
        builder: (context, state) => const ProfileEditScreen(),
      ),
    ],
  );
  ref.onDispose(router.dispose);
  return router;
});
